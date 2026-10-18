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
npm run validate   # check + test + verify + golden
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

The field renderer caches static geometry at the current canvas size and pixel ratio; moving robots,
FUEL, HUB state and HUMAN PLAYER actions are still drawn per frame. Resizing or changing pixel density
rebuilds the background. The HUD updates its phase and HUB markup only when those values change.
These changes affect presentation and task handling; the physics, rule constants and policy weights
remain covered by the existing invariant and golden-replay checks.

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
  evenly) where real Einstein Finals alliances managed 111-177.
- TELEOP throughput is high: 5.36 FUEL/s per alliance against ≈4.7 in the real finals.
- The YELLOW/RED CARD ladder is not priced. A second YELLOW in a phase is a DISQUALIFICATION and its
  tournament cost is outside the model (`sc.contactFouls`).
- TRAVERSAL RP is rarely reached, so the TOWER ladder is softer than a real elite alliance's.
- The HUMAN PLAYER is a throw rate and an accuracy, not a person.

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
