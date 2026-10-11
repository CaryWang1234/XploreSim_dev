// What the per-ROBOT levers are actually worth, on the build that is shipping.
//
// The site's "Rule sources" tab quotes a driver ladder and a 1v1 figure. Both were measured by an
// ad-hoc script that was never committed, against an engine that has since changed shape (square
// footprints, oriented collisions, a Dumper that has to turn its shooting face onto the HUB). A
// number nobody can re-run is not evidence, so this reproduces them on the current engine and prints
// the seed sets separately: a lever whose effect only shows up on one seed set is not a lever.
//
//   node scripts/lever.mjs
//   MATCHES=24 SEEDS=20260110,88101 ITER=200 node scripts/lever.mjs
//
// Every measurement uses the PINNED all-SCORE plan, which is what the calibration mirror uses:
// neither side defends, so what is left is the cycle, and a cycle is what a driver, a drivetrain and
// a benched ROBOT change. The two alliances are always set the same way, so a lever is the only
// difference between them.

import { SAMPLES, makeAlliance, defaultScenario } from '../web/js/model.js';
import { DEFAULT_WEIGHTS } from '../web/js/ai.js';
import { createAI } from '../web/js/policy.js';
import { capOf } from '../web/js/league.js';
import { emptyPlan } from '../web/js/fastsim.js';
import { simulateMatch } from '../web/js/engine.js';

const MATCHES = Number(process.env.MATCHES || 24);
const ITER = Number(process.env.ITER || 200);
const SEEDS = (process.env.SEEDS || '20260110,88101').split(',').map((s) => Number(s.trim()));

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

// A pinned mirror over both seed sets, returning the mean score of one ALLIANCE. `prep(profile, slot)`
// rewrites the six reference profiles; `slot` is the DRIVER STATION within its own alliance (0..2), so
// benching is expressible without writing the match loop twice.
function pinnedMirror(prep) {
  const rows = SEEDS.map((seed) => {
    let sum = 0;
    for (let i = 0; i < MATCHES; i++) {
      const sc = { ...defaultScenario(), ...SCENARIO, seed: (seed + i * 7919) >>> 0 };
      // Both ALLIANCES fly the same trio: with one trio on each side, a lever's delta carries the
      // difference between two ROSTERS as well as the change being measured (mirror.mjs has the story).
      const trio = SAMPLES.slice(0, 3).map(prep);
      const redAll = makeAlliance(trio, 'red');
      const blueAll = makeAlliance(trio, 'blue');
      const plan = emptyPlan();
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
      sum += (res.final.red.total + res.final.blue.total) / 2;
    }
    return { seed, mean: sum / MATCHES };
  });
  return { rows, mean: rows.reduce((a, b) => a + b.mean, 0) / rows.length };
}

const line = (label, r) =>
  `  ${label.padEnd(22)} pooled ${r.mean.toFixed(1).padStart(6)}   (${r.rows.map((x) => `${x.seed}: ${x.mean.toFixed(1)}`).join('  ')})`;

console.log(`levers on the pinned all-SCORE mirror, ${MATCHES} MATCHes x ${SEEDS.length} seed sets, iterations ${ITER}`);
console.log('(mean score of one ALLIANCE; both sides are set the same way, so the label is the only difference)');

// ONLY=intake,chassis runs a subset. Each block is a full mirror over every seed set, so re-measuring
// all of them to check one lever wastes most of the run.
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (k) => !ONLY.length || ONLY.includes(k);

if (want('driver')) {
  console.log('\nDRIVER:');
  for (const d of ['rookie', 'average', 'good', 'elite']) console.log(line(d, pinnedMirror((p) => ({ ...p, driver: d }))));
}

if (want('chassis')) {
  console.log('\nCHASSIS (turn rate left at each chassis reference):');
  for (const c of ['swerve', 'tank', 'mecanum']) console.log(line(c, pinnedMirror((p) => ({ ...p, chassis: c }))));
}

if (want('mechanism')) {
  console.log('\nMECHANISM:');
  for (const m of ['turret', 'dumper']) console.log(line(m, pinnedMirror((p) => ({ ...p, mechanism: m }))));
}

// The intake face is a lever and not a cosmetic: the mouth is a cone, the car sweeps a pile by leading
// with it, so moving it to the back turns every collection trip into a reverse at the chassis's reverse
// fraction of top speed. Run against both a swerve and a tank, because a side intake on a tank has no
// strafe to lead with and the two combinations fail differently.
if (want('intake')) {
  for (const ch of ['swerve', 'tank']) {
    console.log(`\nINTAKE FACE (${ch}):`);
    for (const s of ['front', 'back', 'left', 'right']) {
      console.log(line(s, pinnedMirror((p) => ({ ...p, chassis: ch, intakeSide: s }))));
    }
  }
}

if (want('size')) {
  console.log('\nFIELD SIZE (a lone ROBOT recovers what fraction of a three-ROBOT ALLIANCE):');
  console.log(line('3v3', pinnedMirror((p) => ({ ...p }))));
  console.log(line('1v1', pinnedMirror((p, slot) => ({ ...p, plays: slot === 0 }))));
}
