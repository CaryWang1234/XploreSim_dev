# XploreSim — REBUILT (2026 FRC) match simulator and tactical planner

A browser-only simulator for the 2026 FIRST game, REBUILT. It plays MATCHes from constants transcribed
from the Game Manual (TU21) with the clause kept next to the code, searches shift-by-shift plans with
MCTS over an analytic model, and replays the result on a canvas field. No build step, no server, no
network at runtime.

Rules source of record: `C:\Users\caryw\Desktop\2026GameManual.pdf` (TU21). Where the Manual contradicts
itself, the conflict is surfaced as a toggle rather than silently resolved — see `RULE_CONFLICTS` in
`web/js/rules.js`.

## Run it

```
npm run serve      # http://127.0.0.1:4180
npm run check      # encoding, index.html tag balance, every module parses
npm run verify     # engine invariants (no FUEL invented, no shot from outside the ALLIANCE ZONE, …)
npm run golden     # replay three pinned MATCHes and compare digests with scripts/golden.json
npm test           # worker recovery, replay export, input guards, and renderer cache regression tests
npm run validate   # check + test + verify + rp + golden
```

Every number the site states is reproducible from a committed script:

| script | what it answers |
| --- | --- |
| `npm run mirror` | the three mirrors (AI's searched plan, the same plan pinned to all-SCORE, the greedy cycling baseline) and the red/blue seat test |
| `npm run ab` | the AI against a named baseline over disjoint seed families; `ARMS=`, `SEAT=`, `N=`, `FAMILIES=`, `SWEEP=`, `PHYS=`, `EFFS=`, `PREPS=`, `DUMPS=` expand arms |
| `npm run seat` | decomposes a same-roster mirror into collected / scored / wasted / blocked per ALLIANCE, under each `autoWinner` |
| `npm run lever` | what DRIVER, chassis, mechanism, intake face and a benched ROBOT are worth |
| `npm run probe` | throughput: FUEL/s, loose-FUEL density, intake tick share |
| `npm run dark` | how the inactive window was spent, and how many shots went into a dead HUB |
| `npm run gap` | collected vs scored vs wasted vs distance, by DRIVER level |
| `npm run team` | the bunching proxies behind `mateSeparation` |
| `npm run cap` | the four capability probes: doomed tail trips, post-fault behaviour, nose/aim error, FUEL caught off its own lane at a window reopen |
| `npm run defcal` | what one defender in a shooting lane actually costs the opponent, with both sides' plans pinned so no search is involved |
| `npm run cards` | whether the card ladder fires and what a disqualification costs: paired on identical seeds, with `OPPONENT=ai` for the win-rate read |
| `npm run rp` | which Table 6-5 rungs can still move: the reach rate and the term spread on both arms, against what the objective claims to weight. Part of `npm run validate` |
| `npm run bench` / `npm run train` | baseline ladder / weight evolution with a holdout gate |
| `npm run night` | the multi-core version of `train`: 150 MATCHes per evaluation, paired differences, a wiring probe, named hypotheses, a pattern-search arm and a blind-mutation arm, then a gate on layouts it never searched. `HOURS=`, `MATCHES=`, `CORES=`, `LAMBDA=`, `OUT_DIR=`; writes to `.tmp/night/` and changes nothing in `web/` |

## Layout

```
web/index.html      the page: cockpit, Numbers, Tactics, Rules
web/styles.css      layout and theme
web/js/rules.js     Manual constants: clock, Table 6-3 HUB windows, point values, foul table, geometry
web/js/engine.js    the 0.1 s-tick kinematic engine: FUEL bookkeeping, intake mouth, shots, contact, HP
web/js/model.js     ROBOT cards, DRIVER levels, chassis, derived capabilities, scenario defaults
web/js/fastsim.js   the analytic model the search plans against
web/js/ai.js        the 23 policy weights, their bounds and their clamps
web/js/policy.js    macro MCTS + Bayesian opponent model + per-ROBOT micro utility policy
web/js/mc.js        one MATCH orchestrator, shared by the UI worker and the scripts
web/js/league.js    baselines, A/B harnesses, the weight evolution loop
web/js/viz.js       canvas field rendering
web/js/ui.js        panels, charts, replay transport, match export/import
web/js/statestore.js  the setup as bytes: autosave and link, validated on the way back in
web/js/scouting.js    scouting CSV in, cards out: the column contract, the units, the refusals
web/js/worker-client.js  worker request lifecycle and recovery after a worker failure
web/js/replay.js    time-based replay sampling that preserves resolution across repeated exports
scripts/            the measurements above, plus serve.mjs and check_web.mjs
```

`reefscape/` is a separate repository with its own history and checks; it is excluded from this
repository by `.gitignore`. Changes to the two simulators should be validated independently.

## Runtime and replay maintenance

The UI captures the input roster, weights and run context before sending a simulation to the worker.
That snapshot is committed with a successful result, used for replay labels and written to the export;
editing the setup while a run is pending must not relabel the result. Calibration and user computations
share a busy guard. Worker startup, execution and message-decoding failures reject waiting requests,
release the controls, and allow a subsequent request to start a new worker.
The Cancel task control terminates the active worker without replacing the previous replay or its
input snapshot. The next computation starts a fresh worker.

Playback owns one animation callback. Pausing or seeking cancels it, and keyboard jumps use MATCH
time rather than a frame count, including imported recordings. Exports sample by elapsed time so
importing and re-exporting a recording does not repeatedly halve its resolution.
Phase controls support Enter/Space; analysis tabs support Left/Right/Home/End with visible keyboard
focus and tab/panel accessibility semantics. Status and progress have accessible text updates.

A Monte Carlo batch returns one row per MATCH — number, seed, both scores, margin, foul points given —
and the extremes carry the index of the MATCH they came from, so the page can name them and replay any of
them. Replay is a re-run, not a stored log: `mc.js` owns the seed stride (`seed + i × 7919`) and the batch
sends back the seed each row was measured on, so a flagged MATCH costs one more MATCH — `npm run verify`
times both arms and prints them, 74 ms of the greedy engine against 286 ms with the AI seat searching — rather
than a frame log kept for all 1200.
The cap is `MAX_BATCH` in `ui.js`; `scripts/check_web.mjs` requires the two inputs' `max` attributes to carry
the same number, and `verify.mjs` re-runs every flagged seed and requires the scores it printed, plus a
byte-identical anchor log for MATCH 1.

One MATCH is now read as a process, not only as a score. The scoreboard's second line per ALLIANCE is the RP
ladder at the frame the scrubber is on (ENERGIZED / SUPERCHARGED / TRAVERSAL against the same thresholds the
final verdict is graded with, taken from the anchor's own `s` block), and the Numbers tab's
**FUEL flow and windows** table gives each ROBOT where its FUEL was when it took it (NEUTRAL ZONE / own
ALLIANCE ZONE / FEED outlet), how much of what its own HUB handed back it kept, and how its seconds and its
inches were spent across the nine intents. The engine counters behind them (`collectFrom`, `fuelReclaimed`,
`modeSec`, `modeIn`, `hubReturned`) are bookkeeping only — no frame field, no event and no random draw is
added, so `scripts/golden.mjs` still replays the same three digests. `verify.mjs`'s flow check holds that the
three source columns sum to `fuelCollected`, that the mode clocks sum to `activeSec` and the mode inches to
the distance already recorded, and that the reclaim column moves with the mechanism it names: with
`hubExitRate: 0` the HUBs return nothing and the column reads zero. `scripts/runtime.test.mjs` additionally
requires the last anchor's FUEL, TOWER and total to equal the final ledger, which is what lets the live line
be the engine's own test rather than a second model of it.

Under that table the Numbers tab draws four charts over the same anchors: the running score of both ALLIANCES
with AUTO and END GAME shaded and a white line at the frame the FIELD is showing, the stretches each HUB would
accept FUEL in, one row a ROBOT of the intent that was steering it, and one bar a ROBOT of FUEL taken split by
NEUTRAL ZONE / own ALLIANCE ZONE / FEED outlet with its reclaim marked past the end of the bar. They are hand
drawn on `<canvas>` by `web/js/ui.js` — no chart library, no request — and every series comes from
`web/js/chartdata.js`, which touches no DOM so `scripts/runtime.test.mjs` can run the same derivations against
a real record. That test is what makes the pictures claims rather than decoration: the two score lines must
end on `final[side].total`, the window bands' open seconds must equal the seconds the note under the charts
prints, the intent bands must cover the MATCH and each one must land within three decision strides of
`modeSec`, the source bars must sum to `fuelCollected`, and a chart that samples keeps at most 241 points.
Because the panels are hidden with `hidden`, a canvas in a panel that is not open has no box to draw into and
falls back to 320 px, so entering the tab redraws all four and re-places the marker on the instant the replay
is already showing. None of this reaches the record: `golden.mjs` still replays the same three digests.

The field renderer caches static geometry at the current canvas size and pixel ratio; moving robots,
FUEL, HUB state and HUMAN PLAYER actions are still drawn per frame. Resizing or changing pixel density
rebuilds the background. The HUD updates its phase and HUB markup only when those values change.
These changes affect presentation and task handling; the physics, rule constants and policy weights
remain covered by the existing invariant and golden-replay checks.

Table 6-5 prints a column per event tier, so a bar is only defined together with the tier. `rules.js`
owns the columns and everything else reads them through `rpBars(event)`: the engine grades the MATCH
against that column and carries the bar out with the verdict, `mc.js` hands that same bar to the page,
and the objective divides by it too, so a district-CHAMPIONSHIP batch cannot be captioned with the
regional number it did not use — which is how this build shipped. `scripts/check_web.mjs` fails any
module outside `rules.js` that names a column, and `scripts/rp.test.mjs` checks the graded bar, the
exported bar and the printed bar against a real MATCH.

## The setup is bytes: an autosave and a link

Nothing was saved before, so twenty minutes of typed pit measurements died on a refresh, and the only way
to hand a setup to a teammate was the per-MATCH replay file — which carries a MATCH, not a question.
`web/js/statestore.js` now turns the six cards, the 23 weights, the scenario switches and the run inputs
into one string; `ui.js` writes it to `localStorage` on any change in the setup panel (debounced 600 ms,
and a no-op when the bytes are already what is stored) and writes the same bytes into a `#s=` fragment for
**Copy setup link**. A card is stored as its preset index plus the fields that moved, which is why the
shipped six-ROBOT setup is 1323 characters and pastes into a chat app.

The link and the storage entry are the same object through the same codec, so a link cannot restore
anything the autosave would not. Everything read back is re-validated rather than trusted, because a
setup is an argument to a physics engine: unknown card fields are dropped and named, out-of-range numbers
are clamped to the editor's own domain, an enum the selects cannot show is refused, weights go through
`clampWeights`, a side with two or zero fielded ROBOTS falls back with a sentence, and a version tag that
is not this build's is refused outright. `__proto__` is copied key by key only after the whitelist, so a
URL cannot write to `Object.prototype`. `scripts/runtime.test.mjs` attacks the decoder with each of those
cases; `scripts/check_web.mjs` holds the two halves in step (the codec touches no DOM, which is what makes
it testable, and the four hand-written option lists in `ui.js` match the lists the decoder accepts).

The parts only a browser can prove were walked through in headless Chromium against `npm run serve`: an
edit reaches storage, Copy writes exactly the bytes storage holds, a reload from the link restores the
card and the seat and the run after it uses the restored card rather than the shipped one, a link pasted
into an open tab applies without a reload, garbage/an-old-version/a `__proto__` payload each come back
with a reason and a working page, and **Forget saved setup** drops both halves. Harness:
`.tmp/browser-setup.mjs` (needs a local Chromium, so it is not part of `npm run validate`).

## A declared AUTO replaces the simulated 20 seconds

The engine's own AUTO is the one place the build is known to be low: `npm run probe` reads ≈97 FUEL an
ALLIANCE against 111-177 at the real Einstein Finals, because a real auto is a preprogrammed play whose
outcome a team has *measured*, not a cycle the physics has to rediscover. Each card therefore has an
**AUTO FUEL scored** box. Blank means the ordinary simulation. A number means that machine starts AUTO
holding that load, its shots in those 20 s are not re-rolled against a modelled accuracy (the typed
number is the measurement), its intake mouth stays shut so the declaration is the AUTO rather than a floor
the emergent cycle can top, and whatever is still in the hopper at the whistle carries into TELEOP like
anything else. `capOf` carries it to `fastsim.js`, so the plan is searched against the AUTO the MATCH will
actually contain instead of the cycle estimate — and inside the model the step is deliberately
sub-additive, because both ALLIANCES draw on the same staged FUEL.

Three things are true because of how it is modelled, and the page says them rather than hiding them: only
the first 8 of a declared load could legally be preloaded (§6.3.4-C), so the rest stands in for a pickup
the engine is not asked to simulate — which is why it is its own ledger column (`AUTO declared → banked`)
instead of a number folded into `fuelCollected`, whose three source columns still sum to it exactly; the
load is clamped by the machine's capacity and the clamp is reported; and `sc.autoRoutine === false` is the
off value, which reproduces the undeclared MATCH to the point. `scripts/runtime.test.mjs` holds all of it:
the declaration fires, `loose-at-t=0` falls by exactly the 96 pieces beyond the three legal preloads (the
FUEL came off the carpet, it was not invented), the AUTO winner flips and with it which HUB is dark in
SHIFT 1 under Table 6-3, and the off switch is exact. No shipped card declares anything, so the calibration
anchor, the mirror and the three golden digests are the same numbers they were.

## Scouting CSV in, cards out

`Import scouting CSV` fills the cards from a file the team already has, read on the machine — no upload,
no network, no server, which is the rule this project keeps. The column contract is
[`docs/scouting-example.csv`](/C:/Users/caryw/Desktop/codes/XploreSim_dev/docs/scouting-example.csv) and
the accepted names are the table at the top of `web/js/scouting.js`; headers are matched case- and
punctuation-insensitively (`Drive Speed`, `drive_speed`, `drivespeedips` are one column), metric columns
arrive under their own names (`Speed m/s`, `Height cm`, `Pass Range (m)`) and are converted into the
Manual's inches and seconds rather than read as inches.

Two deliberate refusals. Aggregate numbers are not mapped: OPR and EPA are per-MATCH point totals, and a
point here is either a FUEL in an active HUB or a TOWER level, so an alliance-level OPR cannot be split
into a drive speed and a cycle rate without guessing which one the team is actually good at — a file that
only carries aggregates imports with a named line per unusable column. And a value that does not fit is
never silently absorbed: a mechanism the engine has no physics for is refused by name, a number outside
the envelope the model can run is clamped *and said* (120 cm becomes a 30 in robot with a line about it),
and a cell that is not a number skips its column instead of writing `Number('') === 0` onto a card. Rows
land where a MATCH can field them: six rows fill both ALLIANCES, fewer fill the seat being planned, and
the leftovers are reported rather than dropped.

`scouting.js` touches no DOM, so `scripts/runtime.test.mjs` feeds it hostile text directly; `check_web.mjs`
holds the rest (the example file still parses clean, and no column writes a field no card has). Walked
through in headless Chromium: the file input, the notes line, the imported card being the card the next
run uses, its declared AUTO reaching the engine (`26 → 26` in the flow ledger), and the import surviving
a reload through the autosave. Harness: `.tmp/browser-scouting.mjs`.

## Two engines, on purpose

`engine.js` is the truth: a tick loop with positions, hopper counts, mouths, flight and collisions.
`fastsim.js` is the fast approximation the MCTS searches with, calibrated to the engine by
`modelEfficiency` at load. A recommendation is only as good as that agreement, so the site publishes the
residual rather than hiding it (`calibrateModel` in `league.js`).

## Measurement discipline

The rules this repo has learned the hard way, all of them from a figure that turned out to be wrong:

- **A mirror means the same three ROBOTs on both sides.** One trio per side is a roster comparison: it
  once produced a "60-point field asymmetry" that was really 254/1678/1690 against 4414/5940/11019.
- **Seat and roster must be crossed, not locked.** In `league.js` the ALLIANCE colour turns over every
  two MATCHes while the trio turns over every MATCH, so pinning a seat still samples both rosters.
- **The engine serves the two ALLIANCES alternately.** Red's ROBOTs are built first, so a plain
  `for (const rb of robots)` lets red win every contested FUEL; that was worth ~30 points between two
  identical policies. The per-tick order is not enough by itself — decisions happen every 0.2 s, so the
  side that decides first has to alternate on that clock, not on the tick.
- **Staging has to be symmetric, not just the code.** The 360-ball NEUTRAL ZONE opening was laid out row
  by row from one corner, which sat the piles nearer one HUB and made a rear intake look worth +20
  points. `neutralLayout` is point-symmetric about the field centre now, and that face effect went away.
- **State n and the error.** A single mirror is ±2%; a 96-MATCH arm is ±5 win points binomial. Margin
  and score are the tighter statistics, so a win-rate move smaller than its error bar is not a result.
- **Print the seat test with the mirror.** `mirror.mjs` reports red−blue per mode and calls the verdict
  at 2.5 standard errors, so an asymmetry cannot be quietly inherited by the next build.
- **Every physics knob has an off value** (`PHYS=` in `ab.mjs`) so an arm is an ablation, not a second guess.
- **Price a play on both sides or not at all.** `defenseEfficacy` was measured (one defender costs the
  attacker a factor of ~0.92), put into the model, and the A/B lost 9.9 win points: the search bought the
  defence it could suddenly see while the model still under-charged the bank that ROBOT would not carry
  into the next window. The geometry stayed; the price went back to 0.
- **Prove a new trigger fires somewhere before claiming it helps.** A mid-SHIFT re-plan that never
  triggers is dead code with a comment attached, so `ai.stats().calls` is checked against an opponent that
  actually changes (`OPP=random`) as well as one that does not.
- **Check the knob is wired before spending generations on it.** `night.mjs` drives every axis to both
  ends of its domain on one MATCH set and drops any axis where not a single MATCH finishes differently.
  The engine is deterministic, so a zero there means the branch was never reachable in the sampled play —
  a number in the weight vector is not the same thing as a strategy dial.
- **A term that cannot move is not a term.** `smoothUtility` weighted all three Table 6-5 rungs. `npm run rp`
  measures the reach rate and the term spread on both arms: ENERGIZED and SUPERCHARGED are reached in
  100.0% of MATCHes (FUEL p10 529 against bars of 100 and 360 — and the 240 district-CHAMPIONSHIP column
  too), so `min(1, fuel/bar)` was exactly 1 for every candidate and 1.7 of the objective's 5.5 maximum
  selected between nobody, while TRAVERSAL is reached in 0% of MATCHes but its term still separates a
  climbing alliance from one that is not. The two FUEL terms are muted and the audit fails in both
  directions — live-and-constant is dead weight, muted-and-moving is a signal thrown away. Muting them
  moved no published number: old-minus-new is exactly 1.7000000000 across the 96 greedy MATCHes and no
  searching-seat MATCH came near the bar, so every fitness *difference* quoted here is the same difference.
- **Measure the null before trusting a difference.** `fitnessTrace` returns the per-MATCH utilities so a
  candidate and the incumbent can be differenced MATCH by MATCH on identical layouts, and the run prints
  the paired difference of a vector against itself first (it must be 0.000±0.000). What that pairing
  removes is the layout the two arms were dealt; it does not remove the luck inside a MATCH, because a
  weight change diverges the field within a few ticks — which is why the sample size, not the pairing, is
  what buys the resolution.

## What the model gets wrong

Stated on the page too, because a planner is used to make decisions:

- AUTO scoring is low: the engine puts ≈97 FUEL in during AUTO (92.4 red, 100.8 blue over 12 MATCHes,
  and `autoWinner: 'auto'` resolves that from the simulation, so a 12-MATCH probe does not split it
  evenly) where real Einstein Finals alliances managed 111-177. The fix for a specific team is the
  card's **AUTO FUEL scored** box, which replaces those 20 seconds with the measurement instead of the
  model — see "A declared AUTO". It is not a fix for the anchor: the shipped cards declare nothing, so
  this gap is still what the calibration is measured against.
- TELEOP throughput is high: 5.36 FUEL/s per alliance against ≈4.7 in the real finals.
- The YELLOW/RED CARD ladder is enforceable now, and it is not switched on. §6.6.1 says yellows are
  additive and a RED disqualifies the team for the MATCH, so `sc.cardLadder` (Setup → "Enforce the card
  ladder") takes the machine that earned the second one out of the rest of the MATCH. `npm run cards`
  measures it on the greedy mirror with contact fouls on, 96 MATCHes paired on identical seeds: 37 MATCHes
  carded, 19 of them losing a ROBOT, 22 YELLOW and 21 RED, and a paired difference of
  **−10.4 ± 2.6 points per ALLIANCE** (4.0 standard errors) — the enforcement is not paperwork. It stays
  off because a DQ in a fifth of MATCHes is not what the real Einstein Finals look like (the setup note
  puts them at 0–2 fouls a MATCH), and the frequency behind it — how often a hard hit actually breaks
  something — is the impairment roll, which has no anchor. The tournament cost of a DQ (a carried yellow
  into the next MATCH, an alliance-wide card in the playoffs per §6.6.3) is still outside the model.
- TRAVERSAL RP is rarely reached, so the TOWER ladder is softer than a real elite alliance's.
- The HUMAN PLAYER is a throw rate and an accuracy, not a person.
- Both FUEL rungs are free at this throughput: every MATCH of both arms clears ENERGIZED (100) and
  SUPERCHARGED (360), and the 240 district-CHAMPIONSHIP column as well (`npm run rp`). A simulated
  elite alliance therefore banks 2 of its 4 BONUS RPs before it has made a decision, and only WIN and
  TRAVERSAL are live as reward. Whether the real top field also sweeps both columns every MATCH is not
  measured here — the calibration anchors are scores, not RP lines — but inside this simulator the
  rung cannot discriminate, which is why the search objective no longer pretends it does.

## Calibration anchors

Real 2026 Einstein Finals data from The Blue Alliance (event `2026cmptx`): alliance average 627, high
842. The greedy same-roster mirror is 591.7 (597.9 and 585.5 across the two trios), 5.6% under that
average. Against the hand-written greedy cycling baseline, on identical ROBOTs, the search wins 67.2% of
MATCHes (n=96, 24 per family over four disjoint seed families) with a margin of +27.9 and a score of
657.3 against 629.5.

The anchor sits 5.6% under, outside the ±2% the mirror is read in, and it is disclosed rather than tuned
back. Three model changes put it there. The BUMP/TRENCH seam (§5.5/§5.6: a TRENCH runs guardrail-to-BUMP,
so the two lanes inside a band meet at one seam and nothing connects them) took about 16 points off the
whole outlet-cap curve. Giving a launch a dispersion costs about 5 points on one sweep of the shipped build
(aiming every shot at the centre reads 597.7 against 592.6 at the 22 in that ships) and is worth 7.8 win
points AGAINST the search, because a fan of loose FUEL around the HUB helps the machine that only cycles
more than it helps the one that plans. And the first version of that fan clamped every launch out to the
HUB's 47 in square footprint, which is outside the 20.85 in opening it was supposed to be aiming at:
limiting that clamp to misses cost a further 1.7 points between builds (593.4 → 591.7) and is what
`scripts/verify.mjs` now measures as two populations.
Re-swept on this build, `hubExitRate` 4.2 → 592.6, 4.6 → 602.3,
5.0 → 613.2, 5.2 → 614.6 at 192 MATCHes per point, with the red-blue split inside one standard error
everywhere: 5.0 would bring the anchor to 2.2% under, which is only at the edge of the band. It is not
shipped. The cap has no independent measurement,
every figure on the page is anchored on it, and moving a calibrated knob to erase the cost of a rule change
is how a simulator stops meaning anything.
