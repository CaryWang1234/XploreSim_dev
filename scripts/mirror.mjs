// The mirrors, which are the numbers the calibration table is anchored on: the same three ROBOTs and
// the same policy on both sides, so the only thing left is how the engine scores.
//
// It lives in the repo because the published figure ("≈639 on the elite mirror, 2% above the real 627
// average") was measured by a script that was never committed, and the figure did not come back when
// the same MATCHes were run through the current engine. A number nobody can re-run is not evidence, so
// this prints all three mirrors side by side — the AI's own searched plan, the same plan PINNED to
// all-SCORE, and the greedy cycling baseline — per-seed AND pooled. That settled it: the ≈639 was the
// GREEDY mirror.
//
// A mirror used to be run with SAMPLES[0..2] on one side and SAMPLES[3..5] on the other, which is two
// different ROBOT sets and not a mirror: greedy against greedy scored 592.5 with the first trio and
// 652.3 with the second, and that roster difference is what the page had been reporting as a red/blue
// SEAT asymmetry. Both trios are now run, each against a copy of itself, and the red-vs-blue split
// inside one trio is the only number left that can mean "the field favours a seat".
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

// Both sample trios, each run against a copy of itself.
const TRIOS = [
  { name: SAMPLES.slice(0, 3).map((p) => p.team).join('/'), profiles: SAMPLES.slice(0, 3) },
  { name: SAMPLES.slice(3, 6).map((p) => p.team).join('/'), profiles: SAMPLES.slice(3, 6) },
];

// The per-MATCH red-minus-blue split, reported with its standard error: within one trio both sides fly
// identical ROBOTs and identical policy, so anything left here is the field, the schedule or the random
// stream. A gap that does not clear ~2 sem is not a seat asymmetry.
function gapOf(diffs) {
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const varn = diffs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, n - 1);
  return { mean, sem: Math.sqrt(varn / n) };
}

function mirror(contactFouls, trio) {
  const rows = SEEDS.map((seed) => {
    const r = monteCarlo({
      profilesRed: trio,
      profilesBlue: trio,
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

// A mirror "with neither side defending" is ambiguous, so this prints the PINNED version: the search
// is not consulted and every ROBOT is held on SCORE for the whole MATCH. It sits between the AI's own
// mirror and the greedy one, which is the point — the search spends score on denial, and pinning it
// gives that spend back without changing the policy the ROBOTs actually fly.
function pinnedMirror(trio) {
  const rows = SEEDS.map((seed) => {
    let rSum = 0;
    let bSum = 0;
    const diffs = [];
    for (let i = 0; i < MATCHES; i++) {
      const sc = { ...defaultScenario(), ...SCENARIO, seed: (seed + i * 7919) >>> 0 };
      const redAll = makeAlliance(trio, 'red');
      const blueAll = makeAlliance(trio, 'blue');
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
      diffs.push(res.final.red.total - res.final.blue.total);
    }
    return { seed, red: rSum / MATCHES, blue: bSum / MATCHES, mean: (rSum + bSum) / (2 * MATCHES), diffs };
  });
  return { rows, mean: rows.reduce((a, b) => a + b.mean, 0) / rows.length, gap: gapOf(rows.flatMap((r) => r.diffs)) };
}

// The calibration row is a mirror of the hand-written cycling plan: the greedy baseline never runs
// DEFEND and never passes, so it is the closest thing to "same policy both sides, nobody defending"
// that is also a real strategy. Printing it next to the AI's own mirror is the point — the AI's
// searched plan trades score for denial, and in a mirror the denial cancels while the cost does not,
// so the AI mirrors LOWER than the plan it is measured against.
function greedyMirror(trio) {
  const rows = SEEDS.map((seed) => {
    let rSum = 0;
    let bSum = 0;
    const diffs = [];
    for (let i = 0; i < MATCHES; i++) {
      const sc = { ...defaultScenario(), ...SCENARIO, seed: (seed + i * 7919) >>> 0 };
      const res = simulateMatch({
        redAlliance: makeAlliance(trio, 'red'),
        blueAlliance: makeAlliance(trio, 'blue'),
        redPolicy: greedyPolicy('red'),
        bluePolicy: greedyPolicy('blue'),
        scenario: sc,
      });
      rSum += res.final.red.total;
      bSum += res.final.blue.total;
      diffs.push(res.final.red.total - res.final.blue.total);
    }
    return { seed, red: rSum / MATCHES, blue: bSum / MATCHES, mean: (rSum + bSum) / (2 * MATCHES), diffs };
  });
  return { rows, mean: rows.reduce((a, b) => a + b.mean, 0) / rows.length, gap: gapOf(rows.flatMap((r) => r.diffs)) };
}

const rowLines = (rows) => rows.map((row) => `  seed ${String(row.seed).padEnd(9)} red ${row.red.toFixed(1).padStart(6)}  blue ${row.blue.toFixed(1).padStart(6)}  mean ${row.mean.toFixed(1).padStart(6)}`).join('\n');

const seat = { pinned: [], greedy: [] };
for (const trio of TRIOS) {
  console.log(`\n===== both ALLIANCES fly ${trio.name} =====`);

  for (const contactFouls of process.env.CONTACT === '1' ? [false, true] : [false]) {
    const { rows, mean } = mirror(contactFouls, trio.profiles);
    console.log(`AI mirror, contactFouls=${contactFouls}  (${rows.length} seed sets x ${MATCHES} MATCHes, iterations ${ITER})`);
    for (const row of rows) {
      console.log(
        `  seed ${String(row.seed).padEnd(9)} red ${row.red.toFixed(1).padStart(6)}  blue ${row.blue.toFixed(1).padStart(6)}  mean ${row.mean.toFixed(1).padStart(6)}` +
          `   |  fuel ${row.r.avgFuel.toFixed(0)}  tower ${row.r.avgTower.toFixed(1)}  RS ${row.r.rpProb.expected.toFixed(2)}`,
      );
    }
    console.log(`  pooled mean ${mean.toFixed(1)}   (the AI's own mirror; the calibration anchor is the GREEDY mirror printed below, and the real Einstein Finals average is 627)`);
  }

  const pinned = pinnedMirror(trio.profiles);
  console.log(`\nmirror with the plan PINNED to all-SCORE (neither side defends), same ${MATCHES} MATCHes per seed set:`);
  console.log(rowLines(pinned.rows));
  console.log(`  pooled mean ${pinned.mean.toFixed(1)}   red-blue ${pinned.gap.mean.toFixed(1)} +- ${pinned.gap.sem.toFixed(1)} over ${SEEDS.length * MATCHES} MATCHes`);
  seat.pinned.push(pinned);

  const greedy = greedyMirror(trio.profiles);
  console.log(`\nmirror of the greedy cycling baseline (same policy both sides, nobody defends):`);
  console.log(rowLines(greedy.rows));
  console.log(`  pooled mean ${greedy.mean.toFixed(1)}   red-blue ${greedy.gap.mean.toFixed(1)} +- ${greedy.gap.sem.toFixed(1)}`);
  seat.greedy.push(greedy);
}

const all = (mode) => gapOf(seat[mode].flatMap((r) => r.rows.flatMap((x) => x.diffs)));
for (const mode of ['pinned', 'greedy']) {
  const g = all(mode);
  const z = g.mean / Math.max(1e-9, g.sem);
  console.log(
    `\nseat test, ${mode} mirror, both trios pooled: red-blue ${g.mean.toFixed(2)} +- ${g.sem.toFixed(2)} points over ${SEEDS.length * MATCHES * TRIOS.length} MATCHes` +
      ` = ${z.toFixed(1)} sem  -> ${Math.abs(z) < 2.5 ? 'no seat asymmetry' : 'seat asymmetry is real'}`,
  );
}
console.log(`roster test, greedy mirror means: ${seat.greedy.map((r) => r.mean.toFixed(1)).join(' vs ')} — the difference between these two is the ROBOTs, not the seat`);
