# Economy Simulator (prototype)

A browser-based economy simulator for the builder/spinner game. It loops the
**fixed 72-item spinner outcome sequence** for a configurable number of spins
and tracks coins, energy, survey points, the jackpot pool, Fast Money triggers,
attacks/repairs, and builder progression — then shows a dashboard, charts, a
spin-by-spin log, and CSV/JSON exports.

Randomness comes **only** from configurable reward ranges and the optional
attack/damage simulation. The spinner sequence itself is deterministic.

## Running it

Either:

- **Double-click `index.html`** — runs fully offline (data is embedded).
- **Or serve it** (nicer for dev): `node tools/server.js` → open
  <http://localhost:4178>.

No build step, no dependencies, no network.

## Project structure

| File | Role |
|------|------|
| `index.html` | UI layout: config sidebar, dashboard, charts, log table |
| `css/styles.css` | Styling (light/dark via `prefers-color-scheme`) |
| `js/data.js` | **Auto-generated** parsed game data (do not hand-edit) |
| `js/engine.js` | Pure simulation engine — no DOM, runs in Node too |
| `js/charts.js` | Dependency-free canvas line charts |
| `js/app.js` | UI controller: config binding, run, render, export |
| `js/auth.js` | Soft password gate shown before the app |
| `tools/gen-data.js` | Regenerates `js/data.js` from the source CSVs |
| `tools/server.js` | Minimal static file server for local preview |
| `data/` | The five source-of-truth CSVs |
| `docs/` | Spec docs (energy system PDF) |

## Password gate

The page shows a password prompt first (`js/auth.js`). The default password is
**`simulator`** — change it before sharing.

To set your own password, open the page, run this in the browser console, and
paste the printed hash into `PASSWORD_SHA256` in `js/auth.js`:

```js
simHash('your new password')   // logs the SHA-256 hex to paste
```

> ⚠️ **This is a soft gate, not real security.** On a *public* repo the source
> and this hash are visible, weak passwords can be brute-forced from the hash,
> and the overlay is bypassable via DevTools. It only deters casual visitors of
> the deployed page. For real protection use one of:
> - a **private** GitHub repo,
> - host-level auth in front of the static site — **Netlify**/​**Vercel**
>   password protection, or **Cloudflare Access**,
> - HTTP basic auth on your own server.

## Source of truth → engine mapping

The five CSVs in `data/` are authoritative. `tools/gen-data.js` parses them into
`js/data.js`. **After editing any CSV, regenerate:**

```
node tools/gen-data.js
```

| CSV (`data/`) | Used for |
|---------------|----------|
| `spinner-outcomes.csv` | The fixed 72-item sequence (`index, category, outcome`) |
| `spinner-values.csv` | Documents each outcome's reward semantics |
| `fast-money-targets.csv` | Escalating survey-point targets per trigger (40) |
| `build-costs.csv` | Upgrade costs `[level][building][base,2★,3★]` |
| `repair-costs.csv` | Repair costs, same shape |

The energy-system spec lives in `docs/energy-system.pdf`.

## Economy model (per spin)

1. **Energy** (models `Energy system.pdf`) — time-based: a regen timer grants
   `regenAmount` every `regenIntervalMin` **only up to the cap**; rewards/events
   may push energy *above* the cap. Each spin costs `spinBaseCost × spinMultiplier`
   and advances the clock by `secondsPerSpin`. When energy is too low to spin the
   player waits for regen (or the run stops, or steps away for a fixed period —
   configurable). A single in-flight regen tick can carry over above the cap but
   is lost if energy is still over the cap when it fires. The summary reports
   elapsed time, time spent waiting, stalls, and regen ticks granted/lost.
2. **Resolve the outcome** for the current sequence position via `config.rewards`
   (keyed by reward family — SurveySays3/5 → SurveySays, KeepOrPass3/5 →
   KeepOrPass). Reward types: fixed coins, coin ranges, coin tiers (MatchAndWin),
   fixed energy (Spins), survey-points+coins (survey modes), survey multipliers
   (Double/TripleSurvey), and survey reveal (HeadStart).
   - **Stage modes** (SurveySays, KeepOrPass, SuddenDeath) use a **success/fail
     route**: a successful attempt awards the HIGH tier, a failed attempt the LOW
     tier. Success probability is set by the **player type** — bad / median /
     good (default 25% / 50% / 75%, all editable). Showdown survey modes
     (Bullseye, SurveySteal) keep a random range between low and high.
3. **Jackpot** — a configurable fraction of coin rewards is contributed to the
   pool (house-funded or skimmed from the player).
4. **Fast Money** — survey points fill a progress bar toward the current target
   (from the Fast Money Trigger Points CSV). On reaching the target, Fast Money
   becomes *ready*; collecting it (auto by default) transfers the **entire
   jackpot pool** to the player, zeroes the pool, advances to the next target,
   and resets progress to 0 (overflow discarded unless `surveyPointCarryover`).
   The jackpot pool and the Fast Money bar are independent systems — the pool
   fills only from coin contributions, the bar only from survey points — and
   they connect *only* at collection. Per-spin log columns make every trigger
   and collection explicit (`survey_points_before/gained/after`,
   `fast_money_target/triggered/collected`, `jackpot_before/collected/after`).
5. **Attacks** — time-based at `attacksPerDay` (spaced by elapsed sim-time, so
   they also land during away/regen periods). On a hit a shield blocks it,
   otherwise it steals a % of coins and damages the latest-built star (creating a
   repair obligation costed from the repair table).
6. **Repair** — auto-repair pays down damage (before or after upgrades).
7. **Spending** — the player buys the next builder upgrade in level→building→star
   order, per the spend policy (greedy / keep-a-reserve / hoard).

### Event log entries

The log is a chronological stream of **typed entries**, not one row per spin.
Each spin emits a `spin` entry for the spinner outcome, followed by dedicated
`fastMoney`, `upgrade`, `attack`, and `repair` entries as those events occur.
Every entry tracks coins as **income (`coins_in`) vs. spent (`coins_out`)**
separately (with a `coins_net` column too) and snapshots the running balances at
that moment — so a Fast Money collection and the upgrades it funds appear as
their own lines. Coin flow is conservation-checked: summing `coins_in − coins_out`
across all entries equals the final wallet exactly. Nothing is hidden.

## Rebalancing

Everything is editable in the left sidebar — starting resources, energy, jackpot
rate, Fast Money behavior, attack/shield/repair behavior, spend policy, and every
per-outcome reward value. Use **Config → Save** to snapshot a configuration and
**Load** to restore it. Set the **RNG seed** for reproducible runs.

> The reward values shipped as defaults are **placeholders**. The CSV "Spinner
> values" sheet only specifies *which* parameters each outcome needs (fixed
> amount vs. range vs. tiers), not the amounts — fill those in to balance.
