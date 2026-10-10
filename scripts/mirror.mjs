// The mirrors, which are the numbers the calibration table is anchored on: same reference ROBOTs and
// the same policy on both sides, so the only thing left is how the engine scores.
//
// It lives in the repo because the published figure ("≈639 on the elite mirror, 2% above the real 627
// average") was measured by a script that was never committed, and the figure did not come back when
// the same MATCHes were run through the current engine. A number nobody can re-run is not evidence,
// so this prints all three mirrors side by side — the AI's own searched plan, the same plan PINNED to
// all-SCORE, and the greedy cycling baseline — per-seed AND pooled. That settled it: the ≈639 was the
// GREEDY mirror, which on the current build is 616.0 against the real Einstein average of 627.
//
//   node scripts/mirror.mjs
//   MATCHES=48 SEEDS=20260110,88101 ITER=200 node scripts/mirror.mjs
//   CONTACT=1 node scripts/mirror.mjs        # also run with §7.4.4 hard-contact fouls on

import { monteCarlo } from '../web/js/mc.js';
import { DEFAULT_WEIGHTS } from '../web/js/ai.js';
import { SAMPLES, makeAlliance, defaultScenario } from '../web/js/model.js';
import { createAI } from '../web/js/policy.js';
import { capOf, greedyPolicy } from '../web/js/league.js';
import { emptyPlan } from '../web/js/fastsim.js';
import { simulateMatch } from '../web/js/engine.js';

const MATCHES = Number(process.env.MATCHES || 24);
const ITER = Number(process.env.ITER || 200);
const SEEDS = (process.env.SEEDS || '20260110,88101').split(',').map((s) => Number(s.trim()));

// Exactly what the setup panel sends: objective rs, regional thresholds, AUTO decided by the
// simulation, LEVEL 1 legal in TELEOP, faults on, hard contact off.
const SCENARIO = {
  objective: 'rs',
  event: 'regional',
  autoWinner: 'auto',
  towerL1TeleopAllowed: true,
  faultsEnabled: true,
  contactFouls: false,
  humanThrowPerSec: { red: 0.4, blue: 0.4 },
  humanAccuracy: { red: 0.75, blue: 0.75 },
};

const red = SAMPLES.slice(0, 3);
const blue = SAMPLES.slice(3, 6);

function mirror(contactFouls) {
  const rows = SEEDS.map((seed) => {
    const r = monteCarlo({
      profilesRed: red,
      profilesBlue: blue,
      weights: DEFAULT_WEIGHTS,
      seed,
      iterations: ITER,
      matches: MATCHES,
      recordFirst: false,
      mode: 'aiVsAi',
      aiSide: 'red',
      scenarioOverride: { ...SCENARIO, contactFouls },
    });
    return { seed, red: r.avgRedScore, blue: r.avgBlueScore, mean: (r.avgRedScore + r.avgBlueScore) / 2, r };
  });
  const mean = rows.reduce((a, b) => a + b.mean, 0) / rows.length;
  return { rows, mean };
}

for (const contactFouls of process.env.CONTACT === '1' ? [false, true] : [false]) {
  const { rows, mean } = mirror(contactFouls);
  console.log(`mirror, contactFouls=${contactFouls}  (${rows.length} seed sets x ${MATCHES} MATCHes, iterations ${ITER})`);
  for (const row of rows) {
    console.log(
      `  seed ${String(row.seed).padEnd(9)} red ${row.red.toFixed(1).padStart(6)}  blue ${row.blue.toFixed(1).padStart(6)}  mean ${row.mean.toFixed(1).padStart(6)}` +
        `   |  fuel ${row.r.avgFuel.toFixed(0)}  tower ${row.r.avgTower.toFixed(1)}  RS ${row.r.rpProb.expected.toFixed(2)}`,
    );
  }
  console.log(`  pooled mean ${mean.toFixed(1)}   (the AI's own mirror; the calibration anchor is the GREEDY mirror printed below, and the real Einstein Finals average is 627)`);
}

// A mirror "with neither side defending" is ambiguous, so this prints the PINNED version: the search
// is not consulted and every ROBOT is held on SCORE for the whole MATCH. It sits between the AI's own
// mirror and the greedy one, which is the point — the search spends score on denial, and pinning it
// gives that spend back without changing the policy the ROBOTs actually fly.
function pinnedMirror() {
  const rows = SEEDS.map((seed) => {
    let rSum = 0;
    let bSum = 0;
    for (let i = 0; i < MATCHES; i++) {
      const sc = { ...defaultScenario(), ...SCENARIO, seed: (seed + i * 7919) >>> 0 };
      const redAll = makeAlliance(red, 'red');
      const blueAll = makeAlliance(blue, 'blue');
      const plan = { side: 'red', ...emptyPlan() };
      const mk = (side, profiles, oppProfiles, rngSeed) =>
        createAI({
          side,
          weights: DEFAULT_WEIGHTS,
          caps: profiles.map(capOf),
          oppProfiles,
          rngSeed,
          iterations: ITER,
          objective: sc.objective,
          event: sc.event,
          towerL1TeleopAllowed: sc.towerL1TeleopAllowed,
          planOverride: { periods: plan.periods, auto: plan.auto, climb: plan.climb },
        });
      const res = simulateMatch({
        redAlliance: redAll,
        blueAlliance: blueAll,
        redPolicy: mk('red', redAll.robots, blueAll.robots, (sc.seed >>> 0) + 11),
        bluePolicy: mk('blue', blueAll.robots, redAll.robots, (sc.seed >>> 0) + 29),
        scenario: sc,
      });
      rSum += res.final.red.total;
      bSum += res.final.blue.total;
    }
    return { seed, red: rSum / MATCHES, blue: bSum / MATCHES, mean: (rSum + bSum) / (2 * MATCHES) };
  });
  return { rows, mean: rows.reduce((a, b) => a + b.mean, 0) / rows.length };
}

const pinned = pinnedMirror();
console.log(`\nmirror with the plan PINNED to all-SCORE (neither side defends), same ${MATCHES} MATCHes per seed set:`);
for (const row of pinned.rows) {
  console.log(`  seed ${String(row.seed).padEnd(9)} red ${row.red.toFixed(1).padStart(6)}  blue ${row.blue.toFixed(1).padStart(6)}  mean ${row.mean.toFixed(1).padStart(6)}`);
}
console.log(`  pooled mean ${pinned.mean.toFixed(1)}`);

// The calibration row is a mirror of the hand-written cycling plan: the greedy baseline never runs
// DEFEND and never passes, so it is the closest thing to "same policy both sides, nobody defending"
// that is also a real strategy. Printing it next to the AI's own mirror is the point — the AI's
// searched plan trades score for denial, and in a mirror the denial cancels while the cost does not,
// so the AI mirrors LOWER than the plan it is measured against.
function greedyMirror() {
  const rows = SEEDS.map((seed) => {
    let rSum = 0;
    let bSum = 0;
    for (let i = 0; i < MATCHES; i++) {
      const sc = { ...defaultScenario(), ...SCENARIO, seed: (seed + i * 7919) >>> 0 };
      const res = simulateMatch({
        redAlliance: makeAlliance(red, 'red'),
        blueAlliance: makeAlliance(blue, 'blue'),
        redPolicy: greedyPolicy('red'),
        bluePolicy: greedyPolicy('blue'),
        scenario: sc,
      });
      rSum += res.final.red.total;
      bSum += res.final.blue.total;
    }
    return { seed, red: rSum / MATCHES, blue: bSum / MATCHES, mean: (rSum + bSum) / (2 * MATCHES) };
  });
  return { rows, mean: rows.reduce((a, b) => a + b.mean, 0) / rows.length };
}

const greedy = greedyMirror();
console.log(`\nmirror of the greedy cycling baseline (same policy both sides, nobody defends):`);
for (const row of greedy.rows) {
  console.log(`  seed ${String(row.seed).padEnd(9)} red ${row.red.toFixed(1).padStart(6)}  blue ${row.blue.toFixed(1).padStart(6)}  mean ${row.mean.toFixed(1).padStart(6)}`);
}
console.log(`  pooled mean ${greedy.mean.toFixed(1)}`);
