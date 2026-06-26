/*
 * engine.js — Economy Simulator core
 * ----------------------------------------------------------------------------
 * Pure simulation engine. No DOM, no I/O. Given a config object and the parsed
 * GAME_DATA, run() loops the fixed 72-item spinner sequence for N spins and
 * returns { summary, log, series, config }.
 *
 * Design goals: transparent (every spin produces a fully-explained log row),
 * deterministic (seeded RNG), and easy to rebalance (all reward values live in
 * config.rewards, keyed by the exact outcome names that appear in the CSV).
 *
 * Works in the browser (attaches to window.Engine) and in Node (module.exports)
 * so the same code can be unit-tested headless.
 */
(function (root) {
  'use strict';

  // --- Seeded RNG (mulberry32). Reproducible runs for balancing. -----------
  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randInt(rng, lo, hi) {
    if (hi <= lo) return Math.round(lo);
    return Math.round(lo + rng() * (hi - lo));
  }

  // Pick an index 0..n-1 from a weight array (auto-normalized). Used for the
  // skill-weighted survey-strike draw.
  function weightedIndex(rng, weights) {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += Math.max(0, weights[i] || 0);
    if (total <= 0) return 0;
    let roll = rng() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= Math.max(0, weights[i] || 0);
      if (roll < 0) return i;
    }
    return weights.length - 1;
  }

  // Human-readable duration from minutes: "3d 4h", "5h 12m", "47m".
  function formatMinutes(min) {
    if (!min || min < 1) return Math.round(min) + 'm';
    const d = Math.floor(min / 1440);
    const h = Math.floor((min % 1440) / 60);
    const m = Math.round(min % 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }

  // Some spinner outcomes are distinct positions that share one reward family.
  // The 3/5 variants of SurveySays and KeepOrPass have no separate values.
  const REWARD_ALIASES = {
    SurveySays3: 'SurveySays', SurveySays5: 'SurveySays',
    KeepOrPass3: 'KeepOrPass', KeepOrPass5: 'KeepOrPass',
  };
  const rewardKeyFor = (outcome) => REWARD_ALIASES[outcome] || outcome;

  function weightedPick(rng, items) {
    const total = items.reduce((s, it) => s + (it.weight || 0), 0);
    if (total <= 0) return items[0];
    let r = rng() * total;
    for (const it of items) {
      r -= it.weight || 0;
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  }

  // --- Default reward table -------------------------------------------------
  // Keyed by the exact outcome names found in the spinner sequence. Values are
  // placeholders meant to be edited in the UI; structure mirrors the semantics
  // documented in "Spinner values.csv".
  function defaultRewards() {
    return {
      // Fixed coin payouts
      CoinsLower: { type: 'coinsFixed', coins: 1000 },
      CoinsMedium: { type: 'coinsFixed', coins: 3000 },
      CoinsHigh: { type: 'coinsFixed', coins: 5000 },
      CoinsSuper: { type: 'coinsFixed', coins: 10000 },

      // Energy ("spins") payouts
      SpinsLow: { type: 'energyFixed', energy: 3 },
      SpinsHigh: { type: 'energyFixed', energy: 5 },

      // Survey modes: reward survey points + coins. For Stage modes the low/high
      // are the FAIL/SUCCESS tiers (success → high, fail → low), gated by player
      // skill. SurveySays3/5 and KeepOrPass3/5 each share one reward family.
      SurveySays: { type: 'surveyAndCoins', spLow: 0, spHigh: 100, coinsLow: 100, coinsHigh: 1000 },
      KeepOrPass: { type: 'surveyAndCoins', spLow: 0, spHigh: 100, coinsLow: 10, coinsHigh: 1500 },
      SuddenDeath: { type: 'surveyAndCoins', spLow: 0, spHigh: 40, coinsLow: 1000, coinsHigh: 3000 },
      Bullseye: { type: 'surveyAndCoins', spLow: 35, spHigh: 70, coinsLow: 500, coinsHigh: 2500 },
      SurveySteal: { type: 'surveyAndCoins', spLow: 50, spHigh: 80, coinsLow: 600, coinsHigh: 1000 },

      // Chance coin events (ranges)
      CoinFrenzy: { type: 'coinsRange', coinsLow: 5000, coinsHigh: 50000 },
      FamilyFortunes: { type: 'coinsRange', coinsLow: 320, coinsHigh: 1600 },
      PodiumShuffle: { type: 'coinsRange', coinsLow: 1000, coinsHigh: 4000 },

      // Three-tier coin reward
      MatchAndWin: {
        type: 'coinsTiers',
        tiers: [
          { coins: 100, weight: 0.6 },
          { coins: 300, weight: 0.3 },
          { coins: 1000, weight: 0.1 },
        ],
      },

      // Survey multipliers (active for a window of spins)
      DoubleSurvey: { type: 'surveyMultiplier', multiplier: 2, durationSpins: 10 },
      TripleSurvey: { type: 'surveyMultiplier', multiplier: 3, durationSpins: 10 },

      // Head start: reveals an answer — modeled as a flat survey-point bonus
      SurveyHeadStart: { type: 'surveyReveal', surveyPoints: 20 },
    };
  }

  function defaultConfig() {
    return {
      // Run
      spins: 100000,
      seed: 12345,

      // Player skill — drives Stage-mode success. A successful attempt awards the
      // HIGH tier; a failed attempt awards the LOW tier. Probability by type:
      playerType: 'median', // 'bad' | 'median' | 'good'
      playerSuccessRateBad: 0.25,
      playerSuccessRateMedian: 0.5,
      playerSuccessRateGood: 0.75,

      // Survey strikes — Survey Says & Keep or Pass run on a "three strikes"
      // rule (fail on the 3rd). Shields auto-absorb strikes (1 each), so a weak
      // player can burn up to 3 shields per round to avoid failing; a strong
      // player rarely strikes and keeps them. The number of raw strikes (0–3)
      // is a weighted draw by player type (weights for [0,1,2,3] strikes).
      surveyShieldsAbsorbStrikes: true,
      surveyStrikeWeightsBad: [0.10, 0.20, 0.30, 0.40],
      surveyStrikeWeightsMedian: [0.35, 0.30, 0.20, 0.15],
      surveyStrikeWeightsGood: [0.65, 0.22, 0.09, 0.04],

      // Starting resources
      startingCoins: 250,
      startingEnergy: 50,
      startingSurveyPoints: 0,
      startingShields: 3,

      // Energy system (models "Energy system.pdf")
      // Cap limits ONLY passive regen; rewards/events may push energy above it.
      energyCap: 50,
      regenAmount: 5, // energy granted per regen tick
      regenIntervalMin: 60, // minutes between regen ticks
      spinBaseCost: 1, // base energy cost; Spin Cost = base × multiplier
      spinMultiplier: 1, // "selected multiplier"
      multiplierScalesRewards: true, // multiplier also scales coin & survey rewards
      secondsPerSpin: 20, // active play time per spin (drives regen accrual)
      waitWhenEmpty: true, // wait for regen when out of energy; false = stop run
      awayMinutesWhenEmpty: 600, // (no-sleep mode only) player stays away this long each time energy empties

      // Daily schedule — people sleep. When enabled, the player only plays
      // during a waking window of `activeHoursPerDay` per 24h; the rest is
      // sleep. Energy still regenerates (capped) overnight, and attacks still
      // happen 24/7 — only *play* is confined to waking hours. With sleep on,
      // the fixed away gap above is superseded by the sleep cycle.
      sleepEnabled: true,
      activeHoursPerDay: 16, // hours awake per day (sleep = 24 − this)

      // Jackpot — mirrors player coin gains. Whenever the player earns coins,
      // the same amount (× rate) is also added to the jackpot pool, which is
      // collected when Fast Money triggers. Default 1.0 = an exact mirror.
      jackpotEnabled: true,
      jackpotSeed: 0,
      jackpotContributionRate: 1.0, // fraction of each coin gain mirrored into the pool
      jackpotSkimFromPlayer: false, // false: player keeps coins, pool funded separately

      // Fast Money — survey points fill an escalating progress bar; on reaching
      // the target the player collects the WHOLE jackpot pool (the two systems
      // connect only at collection). See "Fast Money Trigger points" CSV.
      fastMoneyEnabled: true,
      fastMoneyAutoCollect: true, // collect the jackpot immediately when ready
      surveyPointCarryover: false, // false = reset progress to 0 (discard overflow)
      fastMoneyRewardMode: 'collect_jackpot', // reserved; only mode for now
      fastMoneyAfterQueue: 'repeatLast', // after the CSV queue ends: 'repeatLast' | 'loop' | 'stop'
      surveyMultiplierAffectsCoins: true, // survey multiplier applies to coin part of survey modes too

      // Attacks / damage
      attacksEnabled: true,
      attacksPerDay: 3, // expected attacks per simulated day (time-based, not per-spin)
      attackCoinStealPct: 0.01, // fraction of current coins stolen on unblocked hit
      attackUsesShields: true,

      // Shields
      shieldGainPerNSpins: 10, // 0 = off; otherwise +1 shield each N spins
      shieldGainPerFastMoney: 0,
      maxShields: 3,

      // Repair
      autoRepair: true, // master switch; repair timing/aggression is persona-driven

      // Spending / builder progression — driven by the selected spender persona
      // (see SPENDER_PERSONAS). The persona decides repair vs upgrade, reserve,
      // and how aggressively to spend; chooseSpendingAction() applies it.
      spenderPersona: 'progression_optimizer',
      maxLevel: 100,

      rewards: defaultRewards(),
    };
  }

  // Flatten the build order into a deterministic sequence of upgrade steps:
  // level -> building(1..4) -> star(1..3). Each step carries its build cost.
  function buildOrder(data, maxLevel) {
    const steps = [];
    const levels = Object.keys(data.buildCosts)
      .map(Number)
      .filter((l) => l <= maxLevel)
      .sort((a, b) => a - b);
    for (const level of levels) {
      const buildings = Object.keys(data.buildCosts[level]).map(Number).sort((a, b) => a - b);
      for (const building of buildings) {
        const costs = data.buildCosts[level][building];
        for (let star = 1; star <= 3; star++) {
          steps.push({ level, building, star, cost: costs[star - 1] });
        }
      }
    }
    return steps;
  }

  // --- Spender personas ----------------------------------------------------
  // Distinct economy-pressure profiles, expressed as a shared parameter object
  // (no per-persona if/else). chooseSpendingAction() reads these knobs. Two
  // spec fields are mapped onto our linear build order:
  //   upgradeSelection → how many upgrades the persona will buy in one spin
  //   repairPriority   → repair-vs-upgrade ordering, and how far a repair may
  //                      dip below the coin reserve (low→within reserve … absolute→whole wallet)
  const UPGRADES_PER_SPIN = {
    cheapest: 1, balanced: 3, highest_affordable: Infinity, completion_focused: Infinity,
  };
  const SPENDER_PERSONAS = [
    {
      id: 'impulsive_builder', name: 'Impulsive Builder',
      description: 'Buys whenever affordable, keeps no reserve, repairs only casually.',
      upgradeIntent: 1, repairIntent: 0.5,
      reserveCoinPercent: 0, reserveCoinFlat: 0, maxSpendPercentOfWallet: 1,
      repairPriority: 'low', upgradeSelection: 'highest_affordable',
      decisionRandomness: 0,
    },
    {
      id: 'progression_optimizer', name: 'Progression Optimizer',
      description: 'Baseline. Small reserve, repairs before expensive upgrades, buys the cheapest useful upgrade.',
      upgradeIntent: 1, repairIntent: 1,
      reserveCoinPercent: 0.05, reserveCoinFlat: 500, maxSpendPercentOfWallet: 1,
      repairPriority: 'high', upgradeSelection: 'cheapest',
      decisionRandomness: 0,
    },
    {
      id: 'safe_builder', name: 'Safe Builder',
      description: 'Large reserve, strongly prioritizes repairs, never spends the whole wallet. Slow but steady.',
      upgradeIntent: 0.85, repairIntent: 1,
      reserveCoinPercent: 0.25, reserveCoinFlat: 2000, maxSpendPercentOfWallet: 0.5,
      repairPriority: 'very_high', upgradeSelection: 'cheapest',
      decisionRandomness: 0,
    },
    {
      id: 'jackpot_saver', name: 'Jackpot Saver',
      description: 'Saves while approaching Fast Money, then splurges right after collecting. Tests jackpot-driven spending bursts.',
      upgradeIntent: 0.9, repairIntent: 0.9,
      reserveCoinPercent: 0.1, reserveCoinFlat: 1000, maxSpendPercentOfWallet: 1,
      repairPriority: 'high', upgradeSelection: 'balanced',
      waitsForFastMoney: true, spendMoreAfterJackpot: true, decisionRandomness: 0.05,
    },
    {
      id: 'casual_inconsistent', name: 'Casual Inconsistent',
      description: 'Often delays upgrades and repairs even when affordable. Models a less optimal real player.',
      upgradeIntent: 0.7, repairIntent: 0.6,
      reserveCoinPercent: 0.1, reserveCoinFlat: 500, maxSpendPercentOfWallet: 0.8,
      repairPriority: 'medium', upgradeSelection: 'cheapest',
      decisionRandomness: 0.4,
    },
  ];
  const getPersona = (id) => SPENDER_PERSONAS.find((p) => p.id === id) || SPENDER_PERSONAS[1];

  // Pick the next spend action for a single decision tick. Pure given its
  // inputs (rng is the engine's seeded source). The engine calls it repeatedly
  // within a spin until it returns { type: 'none' }. Returns
  //   { type: 'repair' | 'upgrade' | 'none', cost, targetBuildingId?, reason,
  //     reserveRequired, affordableCount }.
  function chooseSpendingAction(state, persona, cfg, rng) {
    const coins = state.coins;
    let reservePct = persona.reserveCoinPercent || 0;
    let reserveFlat = persona.reserveCoinFlat || 0;
    let upgradeIntent = persona.upgradeIntent != null ? persona.upgradeIntent : 1;
    const repairIntent = persona.repairIntent != null ? persona.repairIntent : 1;

    // Save harder while approaching the next Fast Money target...
    if (persona.waitsForFastMoney && state.fmProgress != null && state.fmProgress >= 0.5) {
      reservePct += 0.3 * state.fmProgress;
      upgradeIntent *= (1 - 0.5 * state.fmProgress);
    }
    // ...then splurge briefly right after a collection.
    if (persona.spendMoreAfterJackpot && state.spinsSinceCollection != null && state.spinsSinceCollection <= 20) {
      reservePct *= 0.3; reserveFlat *= 0.3; upgradeIntent = Math.min(1, upgradeIntent * 1.5);
    }
    // Near build completion, optionally raise upgrade intent.
    if (persona.completionBoostThreshold != null && state.buildTotal > 0
        && state.buildStep / state.buildTotal >= persona.completionBoostThreshold
        && persona.completionBoostUpgradeIntent != null) {
      upgradeIntent = persona.completionBoostUpgradeIntent;
    }

    const reserve = Math.max(reserveFlat, coins * reservePct);
    const maxSpend = coins * (persona.maxSpendPercentOfWallet != null ? persona.maxSpendPercentOfWallet : 1);
    const spendable = Math.max(0, coins - reserve);

    // How much a repair may spend depends on repair priority.
    const priority = persona.repairPriority || 'medium';
    let repairBudget;
    if (priority === 'absolute') repairBudget = coins;                       // ignore reserve & cap
    else if (priority === 'very_high') repairBudget = Math.max(0, coins - reserveFlat); // ignore % reserve & cap
    else repairBudget = Math.min(spendable, maxSpend);                       // within reserve & cap
    const repairPay = state.pendingRepair > 0 ? Math.min(state.pendingRepair, repairBudget) : 0;
    const repairPossible = cfg.autoRepair && repairPay > 0 && !state.repairedThisSpin;

    // Upgrade = the next linear step, if affordable within reserve & per-spin cap.
    const cap = UPGRADES_PER_SPIN[persona.upgradeSelection] != null
      ? UPGRADES_PER_SPIN[persona.upgradeSelection] : Infinity;
    const upgradeCost = state.nextUpgradeCost;
    const upgradePossible = upgradeCost != null
      && state.upgradesThisSpin < cap
      && (coins - upgradeCost) >= reserve
      && upgradeCost <= maxSpend;

    const affordableCount = (repairPossible ? 1 : 0) + (upgradePossible ? 1 : 0);
    const base = { reserveRequired: Math.round(reserve), affordableCount };
    const none = (reason) => Object.assign({ type: 'none', cost: 0, reason }, base);

    if (affordableCount === 0) {
      return none(state.pendingRepair > 0 || upgradeCost != null
        ? 'nothing affordable within reserve' : 'nothing left to buy');
    }
    // Random hesitation — models players who don't always act.
    if (persona.decisionRandomness && rng() < persona.decisionRandomness) {
      return none('persona delayed spending (randomness)');
    }

    // High-priority repair pre-empts upgrades; medium/low repair acts only when
    // no upgrade is taken (or, with repairOnlyIfBlocked, only when blocking one).
    const repairFirst = repairPossible
      && (priority === 'absolute' || priority === 'very_high' || priority === 'high')
      && (!persona.repairOnlyIfBlocked || !upgradePossible);

    if (repairFirst && rng() < repairIntent) {
      return Object.assign({ type: 'repair', cost: repairPay, reason: `repair first (${priority} priority)` }, base);
    }
    if (upgradePossible) {
      if (rng() < upgradeIntent) {
        const s = state.nextStep;
        return Object.assign({ type: 'upgrade', cost: upgradeCost,
          targetBuildingId: s ? `L${s.level}B${s.building}★${s.star}` : '',
          reason: `buy next upgrade (${persona.upgradeSelection})` }, base);
      }
      return none(`skipped upgrade (intent ${upgradeIntent.toFixed(2)})`);
    }
    if (repairPossible) {
      if (rng() < repairIntent) {
        return Object.assign({ type: 'repair', cost: repairPay, reason: `repair (${priority} priority)` }, base);
      }
      return none(`skipped repair (intent ${repairIntent.toFixed(2)})`);
    }
    return none('no action');
  }

  function repairCostFor(data, level, building, star) {
    const lvl = data.repairCosts[level];
    if (!lvl || !lvl[building]) return 0;
    return lvl[building][star - 1] || 0;
  }

  function run(config, data) {
    const cfg = config;
    const rng = makeRng(cfg.seed);
    const seq = data.outcomes; // 72 items, looped
    const order = buildOrder(data, cfg.maxLevel);

    // --- Mutable state ------------------------------------------------------
    let coins = cfg.startingCoins;
    let energy = cfg.startingEnergy;
    let shields = cfg.startingShields;
    let jackpot = cfg.jackpotSeed; // jackpot pool — fills via coin contributions

    // --- Fast Money state (survey points fill the progress bar) -------------
    let surveyPoints = cfg.startingSurveyPoints; // current progress toward the target
    let totalSurveyPointsEarned = cfg.startingSurveyPoints; // cumulative (analytics)
    let fastMoneyTriggerIndex = 0; // 0-based index into data.fastMoney
    let currentFastMoneyTarget = data.fastMoney.length ? data.fastMoney[0].target : Infinity;
    let fastMoneyReady = false; // target reached, awaiting collection
    let deferredTarget = 0; // target/index reached but not yet collected (auto-collect off)
    let deferredIndex = 0;
    let fastMoneyCollectedCount = 0; // jackpot collections
    let totalJackpotCollected = 0;
    let fmTriggers = 0; // times the target was reached
    let buildStep = 0; // number of upgrade steps purchased
    let coinsInvested = 0;
    let pendingRepair = 0; // coins owed for damage
    let damagedStars = 0;
    let builtRepairTotal = 0; // sum of repair cost of every star built so far;
    // caps pendingRepair so damage can't stack past "repair everything built".

    let surveyMultiplier = 1;
    let surveyMultUntil = -1; // spin index until which multiplier is active

    // --- Aggregates ---------------------------------------------------------
    const totals = {
      coinsEarned: 0,
      coinsSpentUpgrades: 0,
      coinsSpentRepairs: 0,
      coinsStolen: 0,
      energyFromRewards: 0,
      energyFromRegen: 0,
      energySpent: 0,
      regenTicksGranted: 0,
      regenTicksLost: 0,
      waitMinutes: 0,
      spinsStalled: 0,
      surveyPointsEarned: 0,
      jackpotContributed: 0,
      stageAttempts: 0,
      stageSuccess: 0,
      stageFail: 0,
      surveyRounds: 0, // Survey Says / Keep or Pass rounds played
      surveyStrikes: 0, // total raw strikes incurred in those rounds
      shieldsSpentSurvey: 0, // shields consumed absorbing survey strikes
      attacks: 0,
      attacksBlocked: 0,
      attacksLanded: 0,
      shieldsGained: 0,
      upgradesPurchased: 0,
      nightsSlept: 0, // number of sleep periods taken
      sleepMinutes: 0, // total time spent asleep
      outcomeCounts: {},
      categoryCounts: {},
    };

    const log = [];
    const series = {
      spin: [],
      coins: [],
      energy: [],
      jackpot: [],
      surveyTotal: [], // cumulative survey points earned
      surveyPoints: [], // current SP progress (sawtooth: fills then resets on collect)
      coinsInCum: [], // cumulative coins earned (income)
      coinsOutCum: [], // cumulative coins spent (outflow)
      waitMin: [], // minutes waited for energy this spin (0 = no stall)
      buildStep: [],
      clockMin: [],
    };
    let cumCoinsIn = 0; // running income total, accumulated in pushEntry
    let cumCoinsOut = 0; // running outflow total

    let stoppedReason = null;
    let spin = 0;

    // --- Energy clock & regen timer (see "Energy system.pdf") ---------------
    // The cap limits only passive regen. A single regen timer is tracked via
    // nextRegenAt (minutes); it is null when no tick is scheduled (at/above cap).
    let clock = 0; // minutes since session start
    let nextRegenAt = energy < cfg.energyCap ? cfg.regenIntervalMin : null;
    let regenThisSpin = 0; // energy gained from regen during the current spin

    // Attacks are time-based (N per simulated day). We accrue an "attack debt"
    // proportional to elapsed clock time and fire one attack per whole unit, so
    // the long-run rate matches attacksPerDay and attacks land during away time.
    let lastAttackClock = 0;
    let attackDebt = 0;

    // Active spender persona + Fast Money cadence (for the Jackpot Saver).
    const activePersona = getPersona(cfg.spenderPersona);
    let lastCollectionSpin = 0; // spin index of the most recent FM collection

    // Start a regen timer if the player is below the cap and none is running.
    const startTimerIfNeeded = () => {
      if (energy < cfg.energyCap && nextRegenAt == null) nextRegenAt = clock + cfg.regenIntervalMin;
    };

    // Advance the clock to `to` minutes, processing every regen tick on the way.
    const advanceClock = (to) => {
      let guard = 0;
      while (nextRegenAt != null && nextRegenAt <= to && guard++ < 1e6) {
        clock = nextRegenAt;
        if (energy < cfg.energyCap) {
          const before = energy;
          energy = Math.min(cfg.energyCap, energy + cfg.regenAmount);
          const gained = energy - before;
          totals.energyFromRegen += gained;
          totals.regenTicksGranted++;
          regenThisSpin += gained;
          // Reached the cap → stop the timer; otherwise schedule the next tick.
          nextRegenAt = energy < cfg.energyCap ? nextRegenAt + cfg.regenIntervalMin : null;
        } else {
          // At/above cap when the tick fires → tick is lost, timer stops.
          totals.regenTicksLost++;
          nextRegenAt = null;
        }
      }
      if (to > clock) clock = to;
    };

    // --- Daily schedule (sleep) --------------------------------------------
    // Each 24h day has a waking window [0, wakeMinPerDay); the rest is sleep.
    // Only *play* is confined to waking hours — regen and attacks continue
    // overnight (advanceClock handles regen, including capped over-cap loss).
    const wakeMinPerDay = (cfg.activeHoursPerDay || 0) * 60;
    const sleepActive = !!cfg.sleepEnabled && wakeMinPerDay > 0 && wakeMinPerDay < 1440;
    const minuteOfDay = (c) => ((c % 1440) + 1440) % 1440;
    const isAsleep = (c) => sleepActive && minuteOfDay(c) >= wakeMinPerDay;
    const nextWakeAt = (c) => (Math.floor(c / 1440) + 1) * 1440; // next day's waking start
    // Sleep boundary (sleep onset) for the day `c` falls in.
    const sleepStartOf = (c) => Math.floor(c / 1440) * 1440 + wakeMinPerDay;
    // If currently asleep, fast-forward to the next waking moment (regen runs).
    const sleepIfNeeded = () => {
      if (!isAsleep(clock)) return 0;
      const t0 = clock;
      startTimerIfNeeded();
      advanceClock(nextWakeAt(clock));
      const slept = clock - t0;
      totals.nightsSlept++;
      totals.sleepMinutes += slept;
      return slept;
    };

    // Target for a given (0-based) trigger index, honoring after-queue behavior.
    const targetForIndex = (idx) => {
      const q = data.fastMoney;
      if (!q.length) return Infinity;
      if (idx < q.length) return q[idx].target;
      if (cfg.fastMoneyAfterQueue === 'loop') return q[idx % q.length].target;
      if (cfg.fastMoneyAfterQueue === 'stop') return Infinity;
      return q[q.length - 1].target; // repeatLast
    };

    // The event log is a chronological stream of typed entries. Each entry
    // tracks coins IN (income) and OUT (spent) separately and snapshots the
    // running balances at the moment it occurs. Fast Money collections and
    // upgrades are their own entries, not folded into the spin row.
    let curSpin = 0; // the spin number entries are tagged with
    const makeEntry = (type, partial) => Object.assign({
      type, spin: curSpin, seqIndex: null, category: type, outcome: '',
      coinsIn: 0, coinsOut: 0, surveyDelta: 0, energyDelta: 0, jackpotDelta: 0,
      surveyPointsBefore: null, surveyPointsGained: 0, surveyPointsAfter: null,
      fastMoneyTarget: currentFastMoneyTarget, fastMoneyTriggerIndex,
      fastMoneyTriggered: false, fastMoneyCollected: false,
      jackpotBefore: null, jackpotCollected: null, jackpotAfter: null,
      spinCost: 0, energyRegen: 0, waitMin: 0, flags: [], detail: '',
      // Spend-decision metadata (populated on upgrade/repair entries).
      spenderPersona: cfg.spenderPersona, spendActionType: null, spendActionCost: 0,
      spendActionReason: '', coinsBeforeSpend: null, coinsAfterSpend: null,
      reserveRequired: null, affordableActionsCount: null, spendTargetId: '',
    }, partial || {});
    const pushEntry = (e) => {
      e.coinsDelta = e.coinsIn - e.coinsOut;
      cumCoinsIn += e.coinsIn;
      cumCoinsOut += e.coinsOut;
      if (e.jackpotBefore == null) e.jackpotBefore = jackpot;
      if (e.jackpotAfter == null) e.jackpotAfter = jackpot;
      if (e.jackpotCollected == null) e.jackpotCollected = 0;
      e.clockMin = Math.round(clock * 10) / 10;
      e.coins = coins;
      e.energy = energy;
      e.shields = shields;
      e.surveyPoints = surveyPoints;
      e.fmProgress = surveyPoints;
      e.surveyTotalEarned = totalSurveyPointsEarned;
      e.jackpot = jackpot;
      e.buildStep = buildStep;
      e.pendingRepair = pendingRepair;
      log.push(e);
    };

    // Collect the jackpot pool into player coins, advance to the next target,
    // and emit a dedicated Fast Money log entry. `reached*` describe the target
    // that was hit; they are captured by the caller before advancing.
    const collectFastMoney = (reachedTarget, reachedIndex) => {
      const jackpotBefore = jackpot;
      const collected = jackpot; // fastMoneyRewardMode === 'collect_jackpot'
      coins += collected;
      totals.coinsEarned += collected;
      totalJackpotCollected += collected;
      jackpot = 0;
      fastMoneyCollectedCount++;
      fastMoneyReady = false;
      lastCollectionSpin = curSpin;

      // Shields awarded on collection (existing behavior).
      if (cfg.shieldGainPerFastMoney) {
        const before = shields;
        shields = Math.min(cfg.maxShields, shields + cfg.shieldGainPerFastMoney);
        totals.shieldsGained += shields - before;
      }

      // Survey-point reset / carryover, then advance the target.
      if (cfg.surveyPointCarryover) surveyPoints -= reachedTarget; // keep overflow
      else surveyPoints = 0; // discard overflow (default)
      fastMoneyTriggerIndex++;
      currentFastMoneyTarget = targetForIndex(fastMoneyTriggerIndex);

      const e = makeEntry('fastMoney', {
        category: 'FastMoney', outcome: 'Fast Money collect',
        coinsIn: collected,
        fastMoneyTriggered: true, fastMoneyCollected: true,
        fastMoneyTarget: reachedTarget, fastMoneyTriggerIndex: reachedIndex,
        jackpotBefore, jackpotCollected: collected, jackpotAfter: 0,
        surveyPointsAfter: surveyPoints,
      });
      e.flags.push('fastMoneyCollect');
      e.detail = `FAST MONEY COLLECT #${fastMoneyCollectedCount}: +${collected} coins from jackpot pool (target ${reachedTarget}) → next target ${currentFastMoneyTarget === Infinity ? '—' : currentFastMoneyTarget}`;
      pushEntry(e);
    };

    const spinCost = cfg.spinBaseCost * cfg.spinMultiplier;
    const betMult = cfg.multiplierScalesRewards ? cfg.spinMultiplier : 1;

    // Stage-mode success probability for the selected player type.
    const successRateByType = {
      bad: cfg.playerSuccessRateBad,
      median: cfg.playerSuccessRateMedian,
      good: cfg.playerSuccessRateGood,
    };
    const stageSuccessRate = successRateByType[cfg.playerType] != null ? successRateByType[cfg.playerType] : 0.5;

    // Survey-strike weights (raw strikes 0..3) for the selected player type.
    const strikeWeightsByType = {
      bad: cfg.surveyStrikeWeightsBad,
      median: cfg.surveyStrikeWeightsMedian,
      good: cfg.surveyStrikeWeightsGood,
    };
    const strikeWeights = strikeWeightsByType[cfg.playerType] || cfg.surveyStrikeWeightsMedian || [0.35, 0.30, 0.20, 0.15];
    const SURVEY_STRIKE_FAMILIES = { SurveySays: true, KeepOrPass: true };

    for (spin = 1; spin <= cfg.spins; spin++) {
      regenThisSpin = 0;
      let waitedThisSpin = 0; // awake time spent waiting for energy (excludes sleep)

      // If it's currently the player's sleep window, sleep until morning first.
      // (Sleep is tracked separately in totals.sleepMinutes, not as a stall.)
      if (sleepActive) sleepIfNeeded();

      // --- Energy gate: wait for regen if the player can't afford the spin --
      // Players don't grind every regen tick even while awake: when out of
      // energy they put the game down for `awayMinutesWhenEmpty`. This applies
      // in both modes; with sleep on, an away gap that runs into the night
      // becomes sleep (player wakes the next morning).
      if (energy < spinCost && cfg.awayMinutesWhenEmpty > 0) {
        startTimerIfNeeded();
        const t0 = clock;
        advanceClock(clock + cfg.awayMinutesWhenEmpty);
        const awaySlept = sleepActive ? sleepIfNeeded() : 0;
        waitedThisSpin += (clock - t0) - awaySlept; // awake away-time counts as a stall; sleep doesn't
      }
      if (energy < spinCost) {
        if (!cfg.waitWhenEmpty) {
          stoppedReason = `Out of energy at spin ${spin} (need ${spinCost}, have ${energy})`;
          spin--;
          break;
        }
        if (spinCost > cfg.energyCap) {
          stoppedReason = `Spin cost (${spinCost}) exceeds energy cap (${cfg.energyCap}); regen alone can't afford a spin (at spin ${spin})`;
          spin--;
          break;
        }
        startTimerIfNeeded();
        const t0 = clock;
        let sleptDuringWait = 0;
        let guard = 0;
        while (energy < spinCost && guard++ < 1e6) {
          startTimerIfNeeded();
          if (nextRegenAt == null) break;
          // If the next regen tick lands after today's bedtime, the player
          // sleeps instead of waiting up — and wakes (usually) with full energy.
          if (sleepActive && nextRegenAt >= sleepStartOf(clock)) {
            advanceClock(sleepStartOf(clock)); // play out the evening up to bedtime
            sleptDuringWait += sleepIfNeeded(); // now asleep → fast-forward to morning
            if (energy >= spinCost) break;
          } else {
            advanceClock(nextRegenAt);
          }
        }
        // Only awake time counts as an energy stall, not the overnight sleep.
        waitedThisSpin += (clock - t0) - sleptDuringWait;
        if (energy < spinCost) {
          stoppedReason = `Stalled waiting for energy at spin ${spin}`;
          spin--;
          break;
        }
      }
      if (waitedThisSpin > 0) {
        totals.waitMinutes += waitedThisSpin;
        totals.spinsStalled++;
      }

      // Spend energy on the spin; dropping below the cap (re)starts the timer.
      energy -= spinCost;
      totals.energySpent += spinCost;
      startTimerIfNeeded();

      curSpin = spin;
      const item = seq[(spin - 1) % seq.length];
      // Resolve the reward via the family key (e.g. SurveySays3 → SurveySays);
      // fall back to an exact key for backward compatibility with old configs.
      const reward = cfg.rewards[rewardKeyFor(item.outcome)] || cfg.rewards[item.outcome] || { type: 'none' };

      totals.outcomeCounts[item.outcome] = (totals.outcomeCounts[item.outcome] || 0) + 1;
      totals.categoryCounts[item.category] = (totals.categoryCounts[item.category] || 0) + 1;

      // Is the survey multiplier active this spin?
      const multActive = spin <= surveyMultUntil ? surveyMultiplier : 1;

      // The spin entry — the spinner outcome and its direct rewards.
      const spinE = makeEntry('spin', { seqIndex: item.index, category: item.category, outcome: item.outcome });

      // Deferred collection: if Fast Money was marked ready on a PRIOR spin
      // (auto-collect off), collect it now — before this spin's survey points
      // are added, so they aren't wiped by the reset. Emits its own FM entry.
      if (fastMoneyReady && cfg.fastMoneyEnabled) {
        collectFastMoney(deferredTarget, deferredIndex);
      }

      // --- Resolve reward ---------------------------------------------------
      let coinGain = 0;
      let spGain = 0;
      switch (reward.type) {
        case 'coinsFixed':
          coinGain = reward.coins;
          spinE.detail = `+${coinGain} coins`;
          break;
        case 'coinsRange':
          coinGain = randInt(rng, reward.coinsLow, reward.coinsHigh);
          spinE.detail = `+${coinGain} coins (range ${reward.coinsLow}-${reward.coinsHigh})`;
          break;
        case 'coinsTiers': {
          const t = weightedPick(rng, reward.tiers);
          coinGain = t.coins;
          spinE.detail = `+${coinGain} coins (tier)`;
          break;
        }
        case 'energyFixed':
          // Reward energy is NOT capped; it may push energy above the cap.
          spinE.energyDelta = reward.energy;
          energy += reward.energy;
          totals.energyFromRewards += reward.energy;
          spinE.detail = `+${reward.energy} energy`;
          break;
        case 'surveyAndCoins': {
          const coinMult = cfg.surveyMultiplierAffectsCoins ? multActive : 1;
          if (item.category === 'Stage') {
            const family = rewardKeyFor(item.outcome);
            let success;
            if (cfg.surveyShieldsAbsorbStrikes && SURVEY_STRIKE_FAMILIES[family]) {
              // Three-strikes rule: draw raw strikes (0–3) weighted by skill,
              // shields auto-absorb strikes (1 each), fail if 3 go unabsorbed.
              const rawStrikes = weightedIndex(rng, strikeWeights);
              const shieldsUsed = Math.min(rawStrikes, shields);
              shields -= shieldsUsed;
              totals.shieldsSpentSurvey += shieldsUsed;
              totals.surveyStrikes += rawStrikes;
              totals.surveyRounds++;
              const netStrikes = rawStrikes - shieldsUsed;
              success = netStrikes < 3;
              if (shieldsUsed > 0) spinE.flags.push('shieldUsed');
              spinE.flags.push(success ? 'success' : 'fail');
              spGain = (success ? reward.spHigh : reward.spLow) * multActive;
              coinGain = (success ? reward.coinsHigh : reward.coinsLow) * coinMult;
              spinE.detail = `${rawStrikes} strike${rawStrikes !== 1 ? 's' : ''}`
                + (shieldsUsed > 0 ? `, ${shieldsUsed} absorbed by shield${shieldsUsed !== 1 ? 's' : ''} (→ ${shields} left)` : '')
                + ` → ${success ? 'SUCCESS' : 'FAIL'}: +${spGain} SP, +${coinGain} coins`;
            } else {
              // Other Stage modes: simple success/fail route by skill.
              success = rng() < stageSuccessRate;
              spGain = (success ? reward.spHigh : reward.spLow) * multActive;
              coinGain = (success ? reward.coinsHigh : reward.coinsLow) * coinMult;
              spinE.flags.push(success ? 'success' : 'fail');
              spinE.detail = `${success ? 'SUCCESS' : 'FAIL'} → +${spGain} SP, +${coinGain} coins` + (multActive > 1 ? ` (x${multActive})` : '');
            }
            totals.stageAttempts++;
            totals[success ? 'stageSuccess' : 'stageFail']++;
          } else {
            // Non-stage survey modes (Showdown) keep the random range.
            spGain = randInt(rng, reward.spLow, reward.spHigh) * multActive;
            coinGain = randInt(rng, reward.coinsLow, reward.coinsHigh) * coinMult;
            spinE.detail = `+${spGain} SP, +${coinGain} coins` + (multActive > 1 ? ` (x${multActive})` : '');
          }
          break;
        }
        case 'surveyMultiplier':
          surveyMultiplier = reward.multiplier;
          surveyMultUntil = spin + reward.durationSpins;
          spinE.flags.push('multiplier');
          spinE.detail = `survey x${reward.multiplier} for ${reward.durationSpins} spins`;
          break;
        case 'surveyReveal':
          spGain = reward.surveyPoints * multActive;
          spinE.detail = `+${spGain} SP (head start)`;
          break;
        default:
          spinE.detail = 'no reward configured';
      }

      // The selected spin multiplier optionally scales coin & survey rewards.
      if (betMult !== 1) {
        coinGain = Math.round(coinGain * betMult);
        spGain = Math.round(spGain * betMult);
      }

      // Apply coin gain — income for the player, mirrored into the jackpot pool.
      const jackpotBeforeMirror = jackpot;
      if (coinGain) {
        let net = coinGain;
        if (cfg.jackpotEnabled && cfg.jackpotContributionRate > 0) {
          const contrib = Math.round(coinGain * cfg.jackpotContributionRate);
          jackpot += contrib;
          totals.jackpotContributed += contrib;
          spinE.jackpotDelta += contrib;
          if (cfg.jackpotSkimFromPlayer) net -= contrib;
        }
        coins += net;
        totals.coinsEarned += net;
        spinE.coinsIn += net;
      }

      // Add survey points (the Fast Money progress bar).
      const surveyBefore = surveyPoints;
      if (spGain) {
        surveyPoints += spGain;
        totalSurveyPointsEarned += spGain;
        totals.surveyPointsEarned += spGain;
        spinE.surveyDelta = spGain;
      }
      spinE.surveyPointsBefore = surveyBefore;
      spinE.surveyPointsGained = spGain;
      spinE.surveyPointsAfter = surveyPoints;
      spinE.fastMoneyTarget = currentFastMoneyTarget;
      spinE.fastMoneyTriggerIndex = fastMoneyTriggerIndex;
      spinE.jackpotBefore = jackpotBeforeMirror; // pool before this spin's mirror

      // Active-play time passes; regen may accrue. Recorded on the spin entry.
      advanceClock(clock + cfg.secondsPerSpin / 60);
      spinE.spinCost = spinCost;
      spinE.energyRegen = regenThisSpin;
      spinE.waitMin = Math.round(waitedThisSpin * 10) / 10;
      if (waitedThisSpin > 0) {
        spinE.flags.push('stalled');
        spinE.detail += ` | waited ${formatMinutes(waitedThisSpin)} for energy`;
      }
      if (regenThisSpin > 0) {
        spinE.flags.push('regen');
        spinE.detail += ` | +${regenThisSpin} energy from regen`;
      }
      pushEntry(spinE); // the spin row is logged first, then its consequences

      // --- Fast Money trigger check (survey points reached the target?) ----
      if (cfg.fastMoneyEnabled && currentFastMoneyTarget !== Infinity) {
        let guard = 0;
        while (surveyPoints >= currentFastMoneyTarget && guard++ < 100) {
          fmTriggers++;
          fastMoneyReady = true; // Fast Money becomes available
          const reachedTarget = currentFastMoneyTarget;
          const reachedIndex = fastMoneyTriggerIndex;
          if (cfg.fastMoneyAutoCollect) {
            collectFastMoney(reachedTarget, reachedIndex); // collect, advance, reset
            if (!cfg.surveyPointCarryover) break; // SP reset to 0 → cannot re-trigger
          } else {
            // Mark ready now; the jackpot is collected at the start of next spin.
            deferredTarget = reachedTarget;
            deferredIndex = reachedIndex;
            const e = makeEntry('fastMoney', {
              category: 'FastMoney', outcome: 'Fast Money ready',
              fastMoneyTriggered: true, fastMoneyTarget: reachedTarget, fastMoneyTriggerIndex: reachedIndex,
            });
            e.flags.push('fastMoneyReady');
            e.detail = `FAST MONEY READY (SP ${Math.round(surveyPoints)} ≥ target ${reachedTarget}) — awaiting collection`;
            pushEntry(e);
            break;
          }
        }
      }

      // --- Periodic shield gain --------------------------------------------
      if (cfg.shieldGainPerNSpins > 0 && spin % cfg.shieldGainPerNSpins === 0) {
        const before = shields;
        shields = Math.min(cfg.maxShields, shields + 1);
        totals.shieldsGained += shields - before;
      }

      // --- Attacks / damage (time-based: N per day) ------------------------
      // Resolve a single attack into its own log entry.
      const fireAttack = () => {
        totals.attacks++;
        const e = makeEntry('attack', { category: 'Attack', outcome: 'Attack' });
        if (cfg.attackUsesShields && shields > 0) {
          shields--;
          totals.attacksBlocked++;
          e.flags.push('blocked');
          e.detail = 'ATTACK blocked by shield';
        } else {
          totals.attacksLanded++;
          e.flags.push('attack');
          const stolen = Math.round(coins * cfg.attackCoinStealPct);
          if (stolen > 0) {
            coins -= stolen;
            totals.coinsStolen += stolen;
            e.coinsOut += stolen;
          }
          // Damage adds a repair obligation, but total damage can never exceed
          // the cost to repair everything actually built (no unbounded stacking).
          const lastStep = buildStep > 0 ? order[buildStep - 1] : null;
          if (lastStep && pendingRepair < builtRepairTotal) {
            const rc = repairCostFor(data, lastStep.level, lastStep.building, lastStep.star);
            pendingRepair = Math.min(pendingRepair + rc, builtRepairTotal);
            damagedStars = Math.min(damagedStars + 1, buildStep);
          }
          e.detail = `ATTACK landed: stole ${stolen} coins, repair owed ${Math.round(pendingRepair)}`;
        }
        pushEntry(e);
      };
      if (cfg.attacksEnabled && cfg.attacksPerDay > 0) {
        // Accrue debt for the time elapsed since the last check (active play +
        // any waiting/away time this spin), then fire one attack per whole unit.
        attackDebt += cfg.attacksPerDay * ((clock - lastAttackClock) / 1440);
        lastAttackClock = clock;
        let guard = 0;
        while (attackDebt >= 1 && guard++ < 1e6) {
          attackDebt -= 1;
          fireAttack();
        }
      }

      // --- Spending: persona-driven repair + builder progression ----------
      // chooseSpendingAction() returns one action at a time; we apply it and
      // ask again until it declines. Consecutive upgrades are aggregated into a
      // single log entry; each repair gets its own. Decision metadata (persona,
      // reason, reserve, affordable count, coins before/after) is recorded.
      {
        let repairedThisSpin = false;
        let upBought = 0, upSpent = 0, upBefore = null, upReason = '', upTarget = '';
        let upReserve = null, upAffordable = null;
        const flushUpgrades = () => {
          if (upBought <= 0) return;
          const cur = order[buildStep - 1];
          const e = makeEntry('upgrade', { category: 'Upgrade', outcome: 'Upgrade', coinsOut: upSpent });
          e.flags.push('upgrade');
          e.spendActionType = 'upgrade';
          e.spendActionCost = upSpent;
          e.spendActionReason = upReason;
          e.coinsBeforeSpend = upBefore;
          e.coinsAfterSpend = coins;
          e.reserveRequired = upReserve;
          e.affordableActionsCount = upAffordable;
          e.spendTargetId = upTarget;
          e.detail = `Bought ${upBought} upgrade${upBought > 1 ? 's' : ''} (−${upSpent} coins) → L${cur.level} B${cur.building} ★${cur.star} (step ${buildStep}/${order.length}) · ${upReason}`;
          pushEntry(e);
          upBought = 0; upSpent = 0; upBefore = null; upReserve = null; upAffordable = null;
        };

        let guard = 0;
        while (guard++ < 5000) {
          const nextStep = buildStep < order.length ? order[buildStep] : null;
          const fmProgress = currentFastMoneyTarget === Infinity ? null
            : Math.min(1, surveyPoints / currentFastMoneyTarget);
          const action = chooseSpendingAction({
            coins, pendingRepair, buildStep, buildTotal: order.length,
            nextUpgradeCost: nextStep ? nextStep.cost : null, nextStep,
            fmProgress, spinsSinceCollection: spin - lastCollectionSpin,
            upgradesThisSpin: upBought, repairedThisSpin,
          }, activePersona, cfg, rng);

          if (action.type === 'upgrade') {
            if (upBefore == null) { upBefore = coins; upReserve = action.reserveRequired; upAffordable = action.affordableCount; }
            coins -= action.cost;
            coinsInvested += action.cost;
            totals.coinsSpentUpgrades += action.cost;
            builtRepairTotal += repairCostFor(data, nextStep.level, nextStep.building, nextStep.star);
            buildStep++;
            totals.upgradesPurchased++;
            upBought++; upSpent += action.cost; upReason = action.reason; upTarget = action.targetBuildingId || '';
          } else if (action.type === 'repair') {
            flushUpgrades(); // preserve temporal order
            const before = coins;
            coins -= action.cost;
            pendingRepair -= action.cost;
            totals.coinsSpentRepairs += action.cost;
            repairedThisSpin = true;
            const e = makeEntry('repair', { category: 'Repair', outcome: 'Repair', coinsOut: action.cost });
            e.flags.push('repair');
            e.spendActionType = 'repair';
            e.spendActionCost = action.cost;
            e.spendActionReason = action.reason;
            e.coinsBeforeSpend = before;
            e.coinsAfterSpend = coins;
            e.reserveRequired = action.reserveRequired;
            e.affordableActionsCount = action.affordableCount;
            if (pendingRepair <= 0) { damagedStars = 0; e.detail = `Repaired damage (−${action.cost} coins) · ${action.reason}`; }
            else e.detail = `Partial repair (−${action.cost} coins, ${Math.round(pendingRepair)} still owed) · ${action.reason}`;
            pushEntry(e);
          } else {
            break; // 'none' — done spending this spin
          }
        }
        flushUpgrades();
      }

      series.spin.push(spin);
      series.coins.push(coins);
      series.energy.push(energy);
      series.jackpot.push(jackpot);
      series.surveyTotal.push(totalSurveyPointsEarned);
      series.surveyPoints.push(Math.round(surveyPoints * 10) / 10);
      series.coinsInCum.push(cumCoinsIn);
      series.coinsOutCum.push(cumCoinsOut);
      series.waitMin.push(Math.round(waitedThisSpin * 10) / 10);
      series.buildStep.push(buildStep);
      series.clockMin.push(Math.round(clock * 10) / 10);
    }

    const finalStep = order[Math.min(buildStep, order.length - 1)] || { level: 0, building: 0, star: 0 };
    const summary = {
      spinsRun: spin > cfg.spins ? cfg.spins : spin,
      stoppedReason,
      spenderPersona: activePersona.id,
      spenderPersonaName: activePersona.name,
      finalCoins: coins,
      finalEnergy: energy,
      finalShields: shields,
      finalJackpot: jackpot,
      // Fast Money / survey points
      surveyPoints, // current progress toward the next target
      totalSurveyPointsEarned,
      finalSurveyTotal: totalSurveyPointsEarned, // back-compat alias
      currentFastMoneyTarget,
      fastMoneyTriggerIndex,
      fastMoneyReady,
      fastMoneyProgressPct: currentFastMoneyTarget === Infinity ? 0
        : Math.min(100, Math.round((surveyPoints / currentFastMoneyTarget) * 1000) / 10),
      fastMoneyTriggers: fmTriggers,
      fastMoneyCollectedCount,
      totalJackpotCollected,
      avgSpinsBetweenCollections: fastMoneyCollectedCount > 0
        ? Math.round(((spin > cfg.spins ? cfg.spins : spin) / fastMoneyCollectedCount) * 10) / 10 : 0,
      buildStep,
      buildStepsTotal: order.length,
      currentLevel: finalStep.level,
      currentBuilding: finalStep.building,
      currentStar: finalStep.star,
      pendingRepair,
      damagedStars,
      coinsInvested,
      spinCost,
      // Player skill / stage outcomes
      playerType: cfg.playerType,
      stageSuccessRateConfig: stageSuccessRate,
      stageSuccessRateObserved: totals.stageAttempts > 0
        ? Math.round((totals.stageSuccess / totals.stageAttempts) * 1000) / 10 : 0,
      elapsedMinutes: Math.round(clock),
      elapsedReadable: formatMinutes(clock),
      waitReadable: formatMinutes(totals.waitMinutes),
      activeMinutes: Math.round(clock - totals.waitMinutes - totals.sleepMinutes),
      sleepEnabled: sleepActive,
      activeHoursPerDay: cfg.activeHoursPerDay,
      sleepReadable: formatMinutes(totals.sleepMinutes),
      ...totals,
    };

    return { summary, log, series, config: cfg, buildOrderLength: order.length, formatMinutes };
  }

  const Engine = {
    defaultConfig, defaultRewards, buildOrder, run, makeRng, formatMinutes, rewardKeyFor,
    SPENDER_PERSONAS, getPersona, chooseSpendingAction,
  };
  root.Engine = Engine;
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
})(typeof window !== 'undefined' ? window : globalThis);
