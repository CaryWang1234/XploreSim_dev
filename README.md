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
scripts/            the measurements above, plus serve.mjs and check_web.mjs
```

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

- AUTO scoring is low: the engine puts ≈83 FUEL in during AUTO (81.0 red, 85.8 blue over 12 MATCHes)
  where real Einstein Finals alliances managed 111-177.
- TELEOP throughput is high: 5.44 FUEL/s per alliance against ≈4.7 in the real finals.
- The YELLOW/RED CARD ladder is not priced. A second YELLOW in a phase is a DISQUALIFICATION and its
  tournament cost is outside the model (`sc.contactFouls`).
- TRAVERSAL RP is rarely reached, so the TOWER ladder is softer than a real elite alliance's.
- The HUMAN PLAYER is a throw rate and an accuracy, not a person.

## Calibration anchors

Real 2026 Einstein Finals data from The Blue Alliance (event `2026cmptx`): alliance average 627, high
842. The greedy same-roster mirror is 615.7 (611.3 and 620.1 across the two trios), 1.8% under that
average. Against the hand-written greedy cycling baseline, on identical ROBOTs, the search wins 79.7% of
MATCHes (n=96, 24 per family over four disjoint seed families) with a margin of +43.6 and a score of
667.2 against 623.6.
