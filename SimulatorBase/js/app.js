/*
 * app.js — UI controller. Binds the config form to Engine.defaultConfig(),
 * renders the dynamic reward editors, runs the simulation, and paints the
 * dashboard, charts, log table, and export/save-load actions.
 */
(function () {
  'use strict';

  const clone = (o) => JSON.parse(JSON.stringify(o));
  // Pristine datasets as generated from the CSVs (for "Reset"). DATA is a
  // working copy the JSON editors mutate; the engine always runs against DATA.
  const BASELINE_DATA = window.GAME_DATA;
  const DATA = clone(window.GAME_DATA);
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

  let config = Engine.defaultConfig();
  let lastResult = null;

  // Category mapping for grouping the reward editors, from the source data.
  const OUTCOME_CAT = {};
  const CAT_ORDER = ['Coins', 'Spins', 'Stage', 'Showdown', 'Chance'];
  // Key by reward family so merged outcomes (SurveySays3/5 → SurveySays) group correctly.
  function rebuildOutcomeCategories() {
    Object.keys(OUTCOME_CAT).forEach((k) => delete OUTCOME_CAT[k]);
    DATA.outcomes.forEach((o) => { OUTCOME_CAT[Engine.rewardKeyFor(o.outcome)] = o.category; });
  }
  rebuildOutcomeCategories();

  const num = (n) => Charts.fmt(n);
  const int = (n) => Math.round(n).toLocaleString();

  // ---- Config <-> form binding -------------------------------------------
  function bindScalarsFromConfig() {
    $$('[data-cfg]').forEach((el) => {
      const key = el.dataset.cfg;
      if (!(key in config)) return;
      if (el.type === 'checkbox') el.checked = !!config[key];
      else el.value = config[key];
    });
    const loops = (config.spins / 72);
    $('#loopInfo').textContent = `= ${loops.toFixed(1)} full sequence loops (${config.spins} spins of 72-item cycle).`;
    bindStrikeWeights();
  }

  function readScalarsIntoConfig() {
    $$('[data-cfg]').forEach((el) => {
      const key = el.dataset.cfg;
      if (!(key in config)) return;
      if (el.type === 'checkbox') config[key] = el.checked;
      else if (el.type === 'number') config[key] = el.value === '' ? 0 : Number(el.value);
      else config[key] = el.value;
    });
    readStrikeWeights();
  }

  // Survey-strike weight arrays — comma-separated text inputs ↔ config arrays.
  const STRIKE_WEIGHT_FIELDS = {
    strikeWeightsBad: 'surveyStrikeWeightsBad',
    strikeWeightsMedian: 'surveyStrikeWeightsMedian',
    strikeWeightsGood: 'surveyStrikeWeightsGood',
  };
  function bindStrikeWeights() {
    Object.keys(STRIKE_WEIGHT_FIELDS).forEach((id) => {
      const el = $('#' + id);
      const arr = config[STRIKE_WEIGHT_FIELDS[id]];
      if (el && Array.isArray(arr)) el.value = arr.join(', ');
    });
  }
  function readStrikeWeights() {
    Object.keys(STRIKE_WEIGHT_FIELDS).forEach((id) => {
      const el = $('#' + id);
      if (!el) return;
      const arr = el.value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
      if (arr.length) config[STRIKE_WEIGHT_FIELDS[id]] = arr;
    });
  }

  // ---- Spender persona ----------------------------------------------------
  const PERSONA_PARAM_LABELS = {
    upgradeIntent: 'Upgrade intent (0–1)', repairIntent: 'Repair intent (0–1)',
    reserveCoinPercent: 'Reserve % of wallet', reserveCoinFlat: 'Reserve floor (coins)',
    maxSpendPercentOfWallet: 'Max spend % of wallet', repairPriority: 'Repair priority',
    upgradeSelection: 'Upgrade selection (per spin)', repairOnlyIfBlocked: 'Repair only if blocking an upgrade',
    waitsForFastMoney: 'Saves while approaching Fast Money', spendMoreAfterJackpot: 'Splurges after a collection',
    completionBoostThreshold: 'Completion boost at (fraction)', completionBoostUpgradeIntent: 'Completion-boost upgrade intent',
    decisionRandomness: 'Decision randomness (skip chance)',
  };
  const PERSONA_PARAM_ORDER = Object.keys(PERSONA_PARAM_LABELS);
  const fmtParam = (v) => {
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
    return String(v);
  };

  function populatePersonaOptions() {
    const sel = $('#personaSelect');
    if (!sel || sel.options.length) return;
    Engine.SPENDER_PERSONAS.forEach((p) => {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.name;
      sel.appendChild(o);
    });
  }

  // Description + read-only parameter table for the active persona, so it's
  // clear *why* the simulator spends or holds.
  function renderPersonaInfo() {
    const p = Engine.getPersona(config.spenderPersona);
    $('#personaDesc').textContent = p.description || '';
    $('#personaParams').innerHTML = PERSONA_PARAM_ORDER
      .filter((k) => p[k] !== undefined)
      .map((k) => `<div class="pp-row"><span class="pp-k">${PERSONA_PARAM_LABELS[k]}</span><span class="pp-v">${fmtParam(p[k])}</span></div>`)
      .join('');
  }

  // ---- Source-data JSON editors -------------------------------------------
  // Pretty JSON with numeric arrays collapsed onto one line, so the large cost
  // tables stay readable and hand-editable.
  function prettyJSON(v) {
    return JSON.stringify(v, null, 2)
      .replace(/\[\s*([-\d.,\s]+?)\s*\]/g, (m, inner) => '[' + inner.replace(/\s+/g, ' ').trim() + ']');
  }

  function validateOutcomes(v) {
    if (!Array.isArray(v) || !v.length) throw new Error('Expected a non-empty array of outcomes.');
    v.forEach((o, i) => {
      if (!o || typeof o.outcome !== 'string' || !o.outcome) throw new Error(`Item ${i}: "outcome" must be a non-empty string.`);
      if (typeof o.category !== 'string' || !o.category) throw new Error(`Item ${i}: "category" must be a non-empty string.`);
    });
  }
  function validateFastMoney(v) {
    if (!Array.isArray(v) || !v.length) throw new Error('Expected a non-empty array of targets.');
    v.forEach((o, i) => {
      if (!o || typeof o.target !== 'number' || !(o.target > 0)) throw new Error(`Item ${i}: "target" must be a positive number.`);
    });
  }
  function validateCostTable(t, name) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error(`${name} must be an object keyed by level.`);
    const levels = Object.keys(t);
    if (!levels.length) throw new Error(`${name} has no levels.`);
    levels.forEach((lvl) => {
      const blds = t[lvl];
      if (!blds || typeof blds !== 'object' || Array.isArray(blds)) throw new Error(`${name}["${lvl}"] must be an object keyed by building.`);
      Object.keys(blds).forEach((b) => {
        const arr = blds[b];
        if (!Array.isArray(arr) || arr.length !== 3 || arr.some((n) => typeof n !== 'number'))
          throw new Error(`${name}["${lvl}"]["${b}"] must be an array of 3 numbers (star costs).`);
      });
    });
  }

  // Each editor: read/write its slice of DATA, validate, and reset from baseline.
  const DATA_EDITORS = {
    outcomes: {
      get: () => DATA.outcomes,
      set: (v) => { DATA.outcomes = v; rebuildOutcomeCategories(); renderRewardEditors(); },
      validate: validateOutcomes,
      reset: () => { DATA.outcomes = clone(BASELINE_DATA.outcomes); rebuildOutcomeCategories(); renderRewardEditors(); },
    },
    fastMoney: {
      get: () => DATA.fastMoney,
      set: (v) => { DATA.fastMoney = v; },
      validate: validateFastMoney,
      reset: () => { DATA.fastMoney = clone(BASELINE_DATA.fastMoney); },
    },
    buildCosts: {
      get: () => DATA.buildCosts,
      set: (v) => { DATA.buildCosts = v; },
      validate: (v) => validateCostTable(v, 'buildCosts'),
      reset: () => { DATA.buildCosts = clone(BASELINE_DATA.buildCosts); },
    },
    repairCosts: {
      get: () => DATA.repairCosts,
      set: (v) => { DATA.repairCosts = v; },
      validate: (v) => validateCostTable(v, 'repairCosts'),
      reset: () => { DATA.repairCosts = clone(BASELINE_DATA.repairCosts); },
    },
  };

  const dataMsg = (key, text, cls) => {
    const el = $(`.data-editor[data-edit-key="${key}"] .de-msg`);
    if (el) { el.textContent = text; el.className = 'de-msg ' + (cls || ''); }
  };
  const fillDataEditor = (key) => {
    const ta = $(`textarea[data-edit="${key}"]`);
    if (ta) ta.value = prettyJSON(DATA_EDITORS[key].get());
  };
  function applyDataEditor(key) {
    const ed = DATA_EDITORS[key];
    const ta = $(`textarea[data-edit="${key}"]`);
    let parsed;
    try { parsed = JSON.parse(ta.value); }
    catch (e) { dataMsg(key, '✗ Invalid JSON: ' + e.message, 'err'); return; }
    try { ed.validate(parsed); }
    catch (e) { dataMsg(key, '✗ ' + e.message, 'err'); return; }
    ed.set(parsed);
    fillDataEditor(key); // reflect normalized formatting
    dataMsg(key, '✓ Applied — affects the next run.', 'ok');
  }
  function initDataEditors() {
    Object.keys(DATA_EDITORS).forEach(fillDataEditor);
    $$('.data-editor').forEach((det) => {
      const key = det.dataset.editKey;
      const file = det.querySelector('input[type="file"]');
      det.querySelectorAll('[data-act]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const act = btn.dataset.act;
          if (act === 'apply') applyDataEditor(key);
          else if (act === 'reset') { ed_reset(key); }
          else if (act === 'download') download(`sim-${key}.json`, prettyJSON(DATA_EDITORS[key].get()), 'application/json');
          else if (act === 'upload') file.click();
        });
      });
      file.addEventListener('change', (e) => {
        const f = e.target.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => { $(`textarea[data-edit="${key}"]`).value = reader.result; applyDataEditor(key); };
        reader.readAsText(f);
        file.value = '';
      });
    });
  }
  function ed_reset(key) {
    DATA_EDITORS[key].reset();
    fillDataEditor(key);
    dataMsg(key, '↺ Reset to source-CSV defaults.', 'ok');
  }

  // ---- Reward editors -----------------------------------------------------
  const FIELD_LABELS = {
    coins: 'Coins', energy: 'Energy', coinsLow: 'Coins low', coinsHigh: 'Coins high',
    spLow: 'SP low', spHigh: 'SP high', surveyPoints: 'Survey points',
    multiplier: 'Multiplier', durationSpins: 'Duration (spins)',
  };

  function renderRewardEditors() {
    const host = $('#rewardEditors');
    host.innerHTML = '';
    const byCat = {};
    Object.keys(config.rewards).forEach((name) => {
      const cat = OUTCOME_CAT[name] || 'Other';
      (byCat[cat] = byCat[cat] || []).push(name);
    });
    const cats = CAT_ORDER.filter((c) => byCat[c]).concat(Object.keys(byCat).filter((c) => !CAT_ORDER.includes(c)));

    cats.forEach((cat) => {
      const group = document.createElement('div');
      group.className = 'cat-group';
      group.innerHTML = `<div class="cat-title">${cat}</div>`;
      byCat[cat].forEach((name) => group.appendChild(rewardCard(name, config.rewards[name])));
      host.appendChild(group);
    });
  }

  function rewardCard(name, r) {
    const card = document.createElement('div');
    card.className = 'reward';
    const head = document.createElement('div');
    head.className = 'rh';
    head.innerHTML = `<span class="rname">${name}</span><span class="rtype">${r.type}</span>`;
    card.appendChild(head);

    const fields = document.createElement('div');
    fields.className = 'fields';

    if (r.type === 'coinsTiers') {
      r.tiers.forEach((t, i) => {
        fields.appendChild(numField(`Tier ${i + 1} coins`, t.coins, (v) => (t.coins = v)));
        fields.appendChild(numField(`Tier ${i + 1} weight`, t.weight, (v) => (t.weight = v), 0.01));
      });
    } else {
      Object.keys(r).forEach((key) => {
        if (key === 'type') return;
        const step = (key === 'multiplier') ? 0.1 : 1;
        fields.appendChild(numField(FIELD_LABELS[key] || key, r[key], (v) => (r[key] = v), step));
      });
    }
    card.appendChild(fields);
    return card;
  }

  function numField(label, value, onChange, step) {
    const wrap = document.createElement('label');
    wrap.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = step || 1;
    inp.value = value;
    inp.addEventListener('change', () => onChange(Number(inp.value)));
    wrap.appendChild(inp);
    return wrap;
  }

  // ---- Run ----------------------------------------------------------------
  function runSimulation() {
    readScalarsIntoConfig();
    const btn = $('#runBtn');
    btn.disabled = true;
    btn.textContent = '… running';
    // Defer so the button state paints before the (synchronous) heavy loop.
    setTimeout(() => {
      try {
        const t0 = performance.now();
        lastResult = Engine.run(config, DATA);
        const ms = (performance.now() - t0).toFixed(0);
        renderDashboard(lastResult, ms);
        renderCharts(lastResult);
        renderLog(lastResult);
        $('#statusCard').classList.add('hidden');
        ['windowBar', 'dashboard', 'chartsSection', 'logSection'].forEach((id) => $('#' + id).classList.remove('hidden'));
      } catch (err) {
        console.error(err);
        alert('Simulation error: ' + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '▶ Run Simulation';
      }
    }, 20);
  }

  // ---- Dashboard ----------------------------------------------------------
  function kpi(k, v, cls) {
    return `<div class="kpi"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div></div>`;
  }

  // ---- Shared time window -------------------------------------------------
  // One control drives Summary, Charts, and Event log together. Expressed as a
  // day range [from, to]; to === Infinity means "to end of run". Presets set
  // [0, N]; "All" = [0, Infinity]; the custom inputs set an arbitrary range.
  let windowRange = { from: 0, to: Infinity };
  let lastRunMs = '0';
  const summaryCache = {}; // 'cum:<day>' -> cumulative summary object

  const isFullWindow = () => windowRange.from <= 0 && windowRange.to === Infinity;

  // Minute bounds for the current window.
  function windowMinutes() {
    return {
      fromMin: Math.max(0, windowRange.from) * 1440,
      toMin: windowRange.to === Infinity ? Infinity : windowRange.to * 1440,
    };
  }

  // Series index bounds [lo, hi) for clockMin values within the window.
  function windowIndices(clockMin) {
    const { fromMin, toMin } = windowMinutes();
    let lo = 0;
    while (lo < clockMin.length && clockMin[lo] < fromMin) lo++;
    let hi = lo;
    while (hi < clockMin.length && clockMin[hi] <= toMin) hi++;
    if (hi <= lo && lo < clockMin.length) hi = lo + 1; // always show ≥1 point
    return { lo, hi };
  }

  // Cumulative summary at a day boundary. Because the sim is seeded and
  // deterministic, re-running truncated to the spin count that fits in `day`
  // reproduces the exact cumulative state — no duplicated accounting. Cached.
  function cumulativeAt(day) {
    if (day === Infinity || !lastResult) return lastResult ? lastResult.summary : null;
    const key = 'cum:' + day;
    if (key in summaryCache) return summaryCache[key];
    const cm = lastResult.series.clockMin;
    const limit = day * 1440;
    let count = 0;
    while (count < cm.length && cm[count] <= limit) count++;
    if (count <= 0) { summaryCache[key] = null; return null; } // nothing by this day
    if (count >= cm.length) { summaryCache[key] = lastResult.summary; return lastResult.summary; }
    const cfg = Object.assign({}, lastResult.config, { spins: count });
    summaryCache[key] = Engine.run(cfg, DATA).summary;
    return summaryCache[key];
  }

  // Metrics that accumulate over the run; a range value is end − start.
  const ADDITIVE_KEYS = [
    'spinsRun', 'elapsedMinutes',
    'coinsEarned', 'coinsSpentUpgrades', 'coinsSpentRepairs', 'coinsStolen',
    'energyFromRewards', 'energyFromRegen', 'energySpent',
    'regenTicksGranted', 'regenTicksLost', 'waitMinutes', 'spinsStalled',
    'surveyPointsEarned', 'jackpotContributed',
    'stageAttempts', 'stageSuccess', 'stageFail',
    'surveyRounds', 'surveyStrikes', 'shieldsSpentSurvey',
    'attacks', 'attacksBlocked', 'attacksLanded',
    'shieldsGained', 'upgradesPurchased',
    'totalSurveyPointsEarned', 'finalSurveyTotal',
    'fastMoneyTriggers', 'fastMoneyCollectedCount', 'totalJackpotCollected',
    'nightsSlept', 'sleepMinutes',
  ];

  // Summary for the current window. Balances reflect the END-of-range state;
  // additive metrics are the difference across the range; rates recomputed.
  function summaryForWindow() {
    if (!lastResult) return null;
    if (isFullWindow()) return lastResult.summary;
    const end = cumulativeAt(windowRange.to);
    if (!end) return null; // window starts beyond the end of the run
    const start = windowRange.from > 0 ? cumulativeAt(windowRange.from) : null;
    if (!start) return end; // from ≤ 0 (or nothing before `from`) → cumulative to end
    const out = Object.assign({}, end); // balances default to end-of-range state
    ADDITIVE_KEYS.forEach((k) => { out[k] = (end[k] || 0) - (start[k] || 0); });
    out.stageSuccessRateObserved = out.stageAttempts > 0
      ? Math.round((out.stageSuccess / out.stageAttempts) * 1000) / 10 : 0;
    out.avgSpinsBetweenCollections = out.fastMoneyCollectedCount > 0
      ? Math.round((out.spinsRun / out.fastMoneyCollectedCount) * 10) / 10 : 0;
    out.elapsedReadable = Engine.formatMinutes(out.elapsedMinutes);
    out.activeMinutes = Math.round(out.elapsedMinutes - out.waitMinutes - out.sleepMinutes);
    out.waitReadable = Engine.formatMinutes(out.waitMinutes);
    out.sleepReadable = Engine.formatMinutes(out.sleepMinutes);
    return out;
  }

  // Human label for the active window.
  function windowLabel() {
    if (isFullWindow()) return 'full run';
    const to = windowRange.to === Infinity ? 'end' : 'day ' + windowRange.to;
    return windowRange.from > 0 ? `day ${windowRange.from} → ${to}` : `first ${windowRange.to}d`;
  }

  // Apply a new window and refresh every section. `from`/`to` in days.
  function setWindow(from, to) {
    windowRange = { from: Math.max(0, from || 0), to: (to == null ? Infinity : to) };
    // Preset buttons are [0, N] / [0, ∞]; highlight the matching one (else none).
    const presetMatch = windowRange.from === 0
      ? (windowRange.to === Infinity ? 'all' : String(windowRange.to)) : null;
    $$('#windowBar .seg').forEach((b) => {
      b.classList.toggle('active', presetMatch != null && b.dataset.win === presetMatch);
    });
    // Reflect custom inputs (blank when a preset/all is active).
    $('#winFrom').value = presetMatch != null ? '' : windowRange.from;
    $('#winTo').value = presetMatch != null ? '' : (windowRange.to === Infinity ? '' : windowRange.to);
    if (lastResult) {
      paintSummary();
      renderCharts(lastResult);
      renderLog(lastResult);
    }
  }

  function renderDashboard(res, ms) {
    lastRunMs = ms;
    Object.keys(summaryCache).forEach((k) => delete summaryCache[k]); // fresh run
    paintSummary();
  }

  function paintSummary() {
    const s = summaryForWindow();
    if (!s) {
      $('#kpis').innerHTML =
        `<div class="kpi" style="grid-column:1/-1"><div class="k">No activity</div><div class="v warn">The run ends before ${windowLabel()} — nothing to show.</div></div>`;
      $('#dashboard .section-title').textContent = `Summary · ${windowLabel()} · computed in ${lastRunMs} ms`;
      return;
    }
    // KPIs grouped by theme so the dashboard reads cleanly instead of one long grid.
    const groups = [];
    const group = (title, cards) => groups.push({ title, cards: cards.filter(Boolean) });

    group('Run &amp; time', [
      kpi('Spins run', int(s.spinsRun)),
      kpi('Sim time elapsed', s.elapsedReadable),
      kpi('Active play time', Engine.formatMinutes(s.activeMinutes)),
      s.sleepEnabled && kpi('Time asleep', s.sleepReadable),
      s.sleepEnabled && kpi('Nights slept', `${int(s.nightsSlept)} · ${int(s.activeHoursPerDay)}h awake/day`),
    ]);
    group('Coins &amp; economy', [
      kpi('Final coins', num(s.finalCoins), s.finalCoins < 0 ? 'neg' : 'pos'),
      kpi('Coins earned', num(s.coinsEarned), 'pos'),
      kpi('Spent: upgrades', num(s.coinsSpentUpgrades), 'neg'),
      kpi('Spent: repairs', num(s.coinsSpentRepairs), 'neg'),
      kpi('Coins stolen', num(s.coinsStolen), s.coinsStolen ? 'neg' : ''),
      kpi('Pending repair', num(s.pendingRepair), s.pendingRepair ? 'warn' : ''),
    ]);
    group('Builder', [
      kpi('Spender persona', s.spenderPersonaName || s.spenderPersona || '—'),
      kpi('Builder progress', `${int(s.buildStep)} / ${int(s.buildStepsTotal)}`),
      kpi('Reached', `L${s.currentLevel} · B${s.currentBuilding} · ★${s.currentStar}`),
    ]);
    group('Fast Money &amp; survey points', [
      kpi('Survey points (now)', `${int(s.surveyPoints)} / ${s.currentFastMoneyTarget === Infinity ? '—' : int(s.currentFastMoneyTarget)}`),
      kpi('Fast Money progress', `${s.fastMoneyProgressPct}%`),
      kpi('FM target #', `#${int(s.fastMoneyTriggerIndex + 1)}`),
      kpi('Jackpot pool (now)', num(s.finalJackpot)),
      kpi('Fast Money triggers', int(s.fastMoneyTriggers)),
      kpi('Fast Money collections', int(s.fastMoneyCollectedCount), 'pos'),
      kpi('Total jackpot collected', num(s.totalJackpotCollected), 'pos'),
      kpi('Avg spins / collection', s.avgSpinsBetweenCollections || '—'),
      kpi('Total survey pts earned', num(s.totalSurveyPointsEarned)),
    ]);
    group('Player skill &amp; surveys', [
      kpi('Player type', `${s.playerType} (${Math.round(s.stageSuccessRateConfig * 100)}%)`),
      kpi('Stage success (obs.)', `${s.stageSuccessRateObserved}%`),
      kpi('Stage attempts (S/F)', `${int(s.stageSuccess)} / ${int(s.stageFail)}`),
      kpi('Survey shields spent', int(s.shieldsSpentSurvey || 0), s.shieldsSpentSurvey ? 'warn' : ''),
      kpi('Avg strikes / survey', s.surveyRounds ? (s.surveyStrikes / s.surveyRounds).toFixed(2) : '—'),
    ]);
    group('Attacks &amp; shields', [
      kpi('Attacks (landed/blocked)', `${int(s.attacksLanded)} / ${int(s.attacksBlocked)}`),
      kpi('Shields gained', int(s.shieldsGained)),
    ]);
    group('Energy', [
      kpi('Final energy', int(s.finalEnergy), s.finalEnergy <= 0 ? 'warn' : ''),
      kpi('Spin cost (energy)', int(s.spinCost)),
      kpi('Energy: regen / reward', `${int(s.energyFromRegen)} / ${int(s.energyFromRewards)}`),
      kpi('Regen ticks lost (over cap)', int(s.regenTicksLost), s.regenTicksLost ? 'warn' : ''),
      kpi('Time waiting on energy', s.waitReadable, s.waitMinutes ? 'warn' : ''),
      kpi('Spins stalled', int(s.spinsStalled), s.spinsStalled ? 'warn' : ''),
    ]);

    const banner = (s.stoppedReason && isFullWindow())
      ? `<div class="kpi-banner warn">Stopped early — ${s.stoppedReason}</div>` : '';
    $('#kpis').innerHTML = banner + groups.map((g) =>
      `<div class="kpi-group"><h3 class="group-title">${g.title}</h3><div class="kpis">${g.cards.join('')}</div></div>`
    ).join('');
    const winTxt = isFullWindow()
      ? `full run (${s.elapsedReadable})`
      : `${windowLabel()} → ${int(s.spinsRun)} spins, ${s.elapsedReadable}`;
    $('#dashboard .section-title').textContent = `Summary · ${winTxt} · computed in ${lastRunMs} ms`;
  }

  // ---- Charts -------------------------------------------------------------
  const SERIES_COLOR = {
    coins: '#2563eb', energy: '#16a34a', jackpot: '#d97706',
    surveyTotal: '#7c3aed', surveyPoints: '#7c3aed', buildStep: '#0891b2',
    waitMin: '#dc2626',
  };
  // Colors for the spinner-category bar chart (match the log category tags).
  const CAT_COLOR = {
    Coins: '#d97706', Stage: '#2563eb', Chance: '#7c3aed',
    Showdown: '#dc2626', Spins: '#16a34a',
  };

  // Count spin entries by spinner category for the category-mix bar chart.
  // Derived from the (possibly windowed) log so it tracks the day selection.
  function categoryCounts(log) {
    const counts = {};
    log.forEach((e) => {
      if (e.type !== 'spin') return;
      counts[e.category] = (counts[e.category] || 0) + 1;
    });
    return counts;
  }

  // Bucket total coin income by source for the coin-sources bar chart. Spin
  // income is split by spinner category; Fast Money collections are their own
  // bucket. Returns only buckets that actually earned coins, largest first.
  function coinSources(log) {
    const buckets = {}; // label -> { value, color }
    const add = (label, color, amt) => {
      if (!buckets[label]) buckets[label] = { value: 0, color };
      buckets[label].value += amt;
    };
    log.forEach((e) => {
      if (!e.coinsIn) return;
      if (e.type === 'fastMoney') add('Fast Money', '#16a34a', e.coinsIn);
      else if (e.type === 'spin') add(e.category, CAT_COLOR[e.category] || '#2563eb', e.coinsIn);
      else add(e.type, '#8b949e', e.coinsIn); // any other income source
    });
    const entries = Object.entries(buckets).sort((a, b) => b[1].value - a[1].value);
    return {
      labels: entries.map(([k]) => k),
      values: entries.map(([, v]) => v.value),
      colors: entries.map(([, v]) => v.color),
    };
  }

  // Friendly labels + colors for coin-sink (outflow) buckets, keyed by entry type.
  const SINK_META = {
    upgrade: { label: 'Upgrades', color: '#2563eb' },
    repair: { label: 'Repairs', color: '#d97706' },
    attack: { label: 'Attacks (stolen)', color: '#dc2626' },
  };

  // Bucket total coin outflow by sink for the coin-sinks bar chart. Outflow is
  // grouped by entry type (upgrades, repairs, attacks). Returns only buckets
  // that actually spent coins, largest first.
  function coinSinks(log) {
    const buckets = {};
    log.forEach((e) => {
      if (!e.coinsOut) return;
      const meta = SINK_META[e.type] || { label: e.type, color: '#8b949e' };
      if (!buckets[meta.label]) buckets[meta.label] = { value: 0, color: meta.color };
      buckets[meta.label].value += e.coinsOut;
    });
    const entries = Object.entries(buckets).sort((a, b) => b[1].value - a[1].value);
    return {
      labels: entries.map(([k]) => k),
      values: entries.map(([, v]) => v.value),
      colors: entries.map(([, v]) => v.color),
    };
  }
  // Charts have their own x-axis mode ('spins' | 'time'); the time *window* is
  // the shared one. Both modes clip the plotted range to that window.
  let chartXAxis = 'spins';

  const dayFmt = (d) => {
    if (d >= 2) return Math.round(d) + 'd';
    if (d >= 1) return d.toFixed(1) + 'd';
    if (d * 24 >= 1) return (d * 24).toFixed(1) + 'h';
    return Math.round(d * 1440) + 'm';
  };

  function renderCharts(res) {
    const s = res.series;
    const n = s.spin.length;
    const { lo, hi } = windowIndices(s.clockMin); // [lo, hi)
    const slice = (arr) => arr.slice(lo, hi);

    let xs, xFormat = null;
    if (chartXAxis === 'spins') {
      xs = slice(s.spin);
    } else {
      xs = slice(s.clockMin).map((m) => m / 1440); // → days
      xFormat = dayFmt;
    }

    $$('canvas[data-series]').forEach((cv) => {
      const key = cv.dataset.series;
      Charts.draw(cv, xs, slice(s[key]), {
        color: SERIES_COLOR[key], zeroBased: true, xFormat,
      });
    });

    // Multi-series: coins earned vs. spent (cumulative).
    $$('canvas[data-multi]').forEach((cv) => {
      Charts.drawMulti(cv, xs, [
        { ys: slice(s.coinsInCum), color: '#16a34a', label: 'Earned' },
        { ys: slice(s.coinsOutCum), color: '#dc2626', label: 'Spent' },
      ], { zeroBased: true, xFormat });
    });

    // Bar charts derive from the log clipped to the shared window.
    const { fromMin, toMin } = windowMinutes();
    const barLog = res.log.filter((e) => e.clockMin >= fromMin && e.clockMin <= toMin);
    $$('canvas[data-bars]').forEach((cv) => {
      const kind = cv.dataset.bars;
      if (kind === 'category') {
        const counts = categoryCounts(barLog);
        const labels = Object.keys(counts);
        Charts.drawBars(cv, labels, labels.map((k) => counts[k]), {
          colors: labels.map((k) => CAT_COLOR[k] || '#2563eb'),
        });
      } else if (kind === 'coinSources') {
        const src = coinSources(barLog);
        Charts.drawBars(cv, src.labels, src.values, { colors: src.colors });
      } else if (kind === 'coinSinks') {
        const sink = coinSinks(barLog);
        Charts.drawBars(cv, sink.labels, sink.values, { colors: sink.colors });
      }
    });

    // Span / coverage note.
    const totalMin = s.clockMin[n - 1] || 0;
    const totalTxt = Engine.formatMinutes(totalMin);
    const shownSpins = Math.max(0, hi - lo);
    const fromTxt = Engine.formatMinutes((s.clockMin[lo] || 0));
    const toTxt = Engine.formatMinutes((s.clockMin[Math.max(lo, hi - 1)] || 0));
    const axisTxt = chartXAxis === 'spins' ? 'spins' : 'time (days)';
    $('#chartSpan').textContent = isFullWindow()
      ? `X-axis: ${axisTxt}. Full run — ${int(n)} spins over ${totalTxt}.`
      : `X-axis: ${axisTxt}. Window ${windowLabel()} — ${int(shownSpins)} spins (${fromTxt} → ${toTxt}); full run is ${totalTxt}.`;
  }

  function setChartAxis(axis) {
    chartXAxis = axis;
    $$('#chartControls .seg').forEach((b) => {
      b.classList.toggle('active', b.dataset.axis === axis);
    });
    if (lastResult) renderCharts(lastResult);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    if (!lastResult) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderCharts(lastResult), 150);
  });

  // ---- Log table ----------------------------------------------------------
  const LOG_LIMIT = 600;

  const TYPE_LABEL = {
    spin: 'Spin', fastMoney: 'Fast Money', upgrade: 'Upgrade', attack: 'Attack', repair: 'Repair',
  };
  const TYPE_ROWCLS = {
    fastMoney: 'row-fastMoney', upgrade: 'row-upgrade', attack: 'row-attack', repair: 'row-repair',
  };
  function renderLog(res) {
    const onlyEvents = $('#filterEvents').checked;
    let rows = res.log;
    // Shared time window: keep entries with clockMin within [from, to].
    if (!isFullWindow()) {
      const { fromMin, toMin } = windowMinutes();
      rows = rows.filter((e) => e.clockMin >= fromMin && e.clockMin <= toMin);
    }
    // "Only event rows" = the dedicated Fast Money / upgrade / attack / repair entries.
    if (onlyEvents) rows = rows.filter((e) => e.type !== 'spin');
    const shown = rows.slice(0, LOG_LIMIT);
    const winTxt = isFullWindow() ? '' : ` within ${windowLabel()}`;
    $('#logCount').textContent =
      `${int(rows.length)} entries${winTxt}${rows.length > LOG_LIMIT ? ` (showing first ${LOG_LIMIT})` : ''}`;

    const html = shown.map((e) => {
      let rowCls = TYPE_ROWCLS[e.type] || '';
      if (!rowCls && e.flags.includes('stalled')) rowCls = 'row-stalled';
      const dj = e.jackpotDelta;
      const tgt = e.fastMoneyTarget === Infinity ? '—' : int(e.fastMoneyTarget);
      const jc = e.jackpotCollected ? `<span class="pos">+${int(e.jackpotCollected)}</span>` : '';
      return `<tr class="${rowCls}">
        <td>${e.spin}</td>
        <td><span class="tag type-${e.type}">${TYPE_LABEL[e.type] || e.type}</span></td>
        <td>${e.seqIndex == null ? '' : e.seqIndex}</td>
        <td>${e.outcome || ''}</td>
        <td class="${e.coinsIn ? 'pos' : ''}">${e.coinsIn ? '+' + int(e.coinsIn) : ''}</td>
        <td class="${e.coinsOut ? 'neg' : ''}">${e.coinsOut ? '−' + int(e.coinsOut) : ''}</td>
        <td>${e.surveyDelta || ''}</td>
        <td class="${cls(e.energyDelta)}">${e.energyDelta ? sign(e.energyDelta) : ''}</td>
        <td class="${e.energyRegen ? 'pos' : ''}">${e.energyRegen ? '+' + int(e.energyRegen) : ''}</td>
        <td class="warn">${e.waitMin ? Engine.formatMinutes(e.waitMin) : ''}</td>
        <td>${dj ? '+' + int(dj) : ''}</td>
        <td>${int(e.coins)}</td><td>${int(e.energy)}</td><td>${e.shields}</td>
        <td>${int(e.fmProgress)}/${tgt}</td><td>${jc}</td><td>${e.buildStep}</td>
        <td>${e.detail}</td>
      </tr>`;
    }).join('');
    $('#logBody').innerHTML = html;
  }
  const sign = (n) => (n > 0 ? '+' + int(n) : n < 0 ? '−' + int(-n) : '0');
  const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

  // ---- Exports ------------------------------------------------------------
  function download(filename, text, type) {
    const blob = new Blob([text], { type: type || 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const csvCell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  function exportLogCsv() {
    if (!lastResult) return alert('Run a simulation first.');
    // [csvHeader, eventField] — Fast Money columns use the requested snake_case.
    const cols = [
      ['spin', 'spin'], ['entry_type', 'type'], ['seq_index', 'seqIndex'], ['category', 'category'], ['outcome', 'outcome'],
      ['coins_in', 'coinsIn'], ['coins_out', 'coinsOut'], ['coins_net', 'coinsDelta'], ['energy_delta', 'energyDelta'],
      ['spin_cost', 'spinCost'], ['energy_regen', 'energyRegen'], ['wait_min', 'waitMin'], ['clock_min', 'clockMin'],
      // Survey points / Fast Money (per spec)
      ['survey_points_before', 'surveyPointsBefore'], ['survey_points_gained', 'surveyPointsGained'],
      ['survey_points_after', 'surveyPointsAfter'], ['fast_money_target', 'fastMoneyTarget'],
      ['fast_money_triggered', 'fastMoneyTriggered'], ['fast_money_collected', 'fastMoneyCollected'],
      ['jackpot_before', 'jackpotBefore'], ['jackpot_collected', 'jackpotCollected'],
      ['jackpot_after', 'jackpotAfter'], ['fast_money_trigger_index', 'fastMoneyTriggerIndex'],
      // Balances after the spin
      ['coins', 'coins'], ['energy', 'energy'], ['shields', 'shields'],
      ['total_survey_points_earned', 'surveyTotalEarned'], ['jackpot_pool', 'jackpot'],
      ['build_step', 'buildStep'], ['pending_repair', 'pendingRepair'],
      // Spend-decision metadata (per persona)
      ['spender_persona', 'spenderPersona'], ['spend_action_type', 'spendActionType'],
      ['spend_action_cost', 'spendActionCost'], ['spend_action_reason', 'spendActionReason'],
      ['spend_target_id', 'spendTargetId'],
      ['coins_before_spend', 'coinsBeforeSpend'], ['coins_after_spend', 'coinsAfterSpend'],
      ['reserve_required', 'reserveRequired'], ['affordable_actions_count', 'affordableActionsCount'],
      ['flags', 'flags'], ['detail', 'detail'],
    ];
    const lines = [cols.map((c) => c[0]).join(',')];
    for (const e of lastResult.log) {
      lines.push(cols.map(([, f]) => {
        let v = f === 'flags' ? e.flags.join('|') : e[f];
        if (v === Infinity) v = '';
        if (typeof v === 'boolean') v = v ? 'TRUE' : 'FALSE';
        return csvCell(v);
      }).join(','));
    }
    download('sim-eventlog.csv', lines.join('\n'), 'text/csv');
  }

  function exportSummaryCsv() {
    if (!lastResult) return alert('Run a simulation first.');
    const s = lastResult.summary;
    const lines = ['metric,value'];
    Object.keys(s).forEach((k) => {
      const v = s[k];
      if (v != null && typeof v === 'object') {
        Object.keys(v).forEach((kk) => lines.push(`${csvCell(k + '.' + kk)},${csvCell(v[kk])}`));
      } else {
        lines.push(`${csvCell(k)},${csvCell(v)}`);
      }
    });
    download('sim-summary.csv', lines.join('\n'), 'text/csv');
  }

  function exportJson() {
    if (!lastResult) return alert('Run a simulation first.');
    download('sim-results.json', JSON.stringify({
      config: lastResult.config,
      summary: lastResult.summary,
      log: lastResult.log,
    }, null, 2), 'application/json');
  }

  function saveConfig() {
    readScalarsIntoConfig();
    download('sim-config.json', JSON.stringify(config, null, 2), 'application/json');
  }
  function loadConfig(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const loaded = JSON.parse(reader.result);
        config = Object.assign(Engine.defaultConfig(), loaded);
        if (loaded.rewards) config.rewards = loaded.rewards;
        bindScalarsFromConfig();
        renderPersonaInfo();
        renderRewardEditors();
      } catch (e) { alert('Invalid config JSON: ' + e.message); }
    };
    reader.readAsText(file);
  }

  // ---- Wire up ------------------------------------------------------------
  function init() {
    populatePersonaOptions();
    bindScalarsFromConfig();
    renderPersonaInfo();
    renderRewardEditors();
    initDataEditors();
    $('#runBtn').addEventListener('click', runSimulation);
    $('#resetBtn').addEventListener('click', () => {
      config = Engine.defaultConfig();
      bindScalarsFromConfig();
      renderPersonaInfo();
      renderRewardEditors();
    });
    $('#personaSelect').addEventListener('change', (e) => {
      config.spenderPersona = e.target.value;
      renderPersonaInfo();
    });
    $('#exportCsv').addEventListener('click', exportLogCsv);
    $('#exportSummaryCsv').addEventListener('click', exportSummaryCsv);
    $('#exportJson').addEventListener('click', exportJson);
    $('#saveConfig').addEventListener('click', saveConfig);
    $('#loadConfigBtn').addEventListener('click', () => $('#loadConfigFile').click());
    $('#loadConfigFile').addEventListener('change', (e) => e.target.files[0] && loadConfig(e.target.files[0]));
    $('#filterEvents').addEventListener('change', () => lastResult && renderLog(lastResult));
    // Chart x-axis (spins vs time) — window itself is shared below.
    $$('#chartControls .seg').forEach((b) => b.addEventListener('click', () => setChartAxis(b.dataset.axis)));
    // Shared time-window presets: [0, N] or [0, ∞].
    $$('#windowBar .seg').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.win;
      setWindow(0, v === 'all' ? Infinity : Number(v));
    }));
    // Custom day range. Blank/invalid `to` means "to end of run".
    const applyCustom = () => {
      const from = Number($('#winFrom').value) || 0;
      const toRaw = $('#winTo').value;
      const to = toRaw === '' || toRaw == null ? Infinity : Number(toRaw);
      if (to !== Infinity && to <= from) { $('#windowInfo').textContent = '"to" must be greater than "from".'; return; }
      $('#windowInfo').textContent = '';
      setWindow(from, to);
    };
    $('#winApply').addEventListener('click', applyCustom);
    [$('#winFrom'), $('#winTo')].forEach((inp) => inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCustom(); }));
    $('input[data-cfg="spins"]').addEventListener('input', (e) => {
      const v = Number(e.target.value) || 0;
      $('#loopInfo').textContent = `= ${(v / 72).toFixed(1)} full sequence loops (${v} spins of 72-item cycle).`;
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
