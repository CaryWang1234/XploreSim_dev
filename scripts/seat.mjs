// Where does a same-roster mirror MATCH's red/blue split actually come from?
//
// The published "the field itself is far more asymmetric, greedy scores 592.5 as red and 652.3 as blue"
// was wrong: those were two different ROSTERS (see mirror.mjs). With one trio on both sides the greedy
// anchor is symmetric (-2 +- 11 points), but the mirror that flies the shipped micro policy still puts
// red ~22 points ahead. This script does not re-litigate that — it decomposes it, printing the per-side
// production chain (collected -> scored -> wasted, shots, blocks, idle frames, foul points, what the
// OUTPOST still held at the whistle) so the stage where the two sides part company is visible.
//
// RUNS names the `autoWinner` values to play the same MATCHes under: 'auto' lets the simulation decide
// (what the site ships), 'red' and 'blue' pin it. Pinning separates "red is served first by the engine"
// from "being the AUTO winner is worth more than being the loser", because the winner sits out SHIFT 1
// and 3 while the loser sits out 2 and 4.
//
//   node scripts/seat.mjs
//   MATCHES=24 TR=0,1 node scripts/seat.mjs
//   RUNS=auto,red,blue node scripts/seat.mjs

import { DEFAULT_WEIGHTS } from '../web/js/ai.js';
import { SAMPLES, makeAlliance, defaultScenario } from '../web/js/model.js';
import { createAI } from '../web/js/policy.js';
import { capOf } from '../web/js/league.js';
import { emptyPlan } from '../web/js/fastsim.js';
import { simulateMatch } from '../web/js/engine.js';

const MATCHES = Number(process.env.MATCHES || 24);
const ITER = Number(process.env.ITER || 200);
const SEED = Number(process.env.SEED || 20260110);
const TRIO_LIST = (process.env.TR || '0,1').split(',').map((s) => Number(s.trim()));
const RUNS = (process.env.RUNS || 'auto,red,blue').split(',').map((s) => s.trim());

const SCENARIO = {
  objective: 'rs',
  event: 'regional',
  towerL1TeleopAllowed: true,
  faultsEnabled: true,
  contactFouls: false,
  humanThrowPerSec: { red: 0.4, blue: 0.4 },
  humanAccuracy: { red: 0.75, blue: 0.75 },
};

function runOnce(trio, autoWinner) {
  const rows = [];
  for (let i = 0; i < MATCHES; i++) {
    const sc = { ...defaultScenario(), ...SCENARIO, autoWinner, seed: (SEED + i * 7919) >>> 0 };
    const redAll = makeAlliance(trio, 'red');
    const blueAll = makeAlliance(trio, 'blue');
    const plan = emptyPlan();
    const mk = (side, own, opp, rngSeed) =>
      createAI({
        side,
        weights: DEFAULT_WEIGHTS,
        caps: own.map(capOf),
        oppProfiles: opp,
        rngSeed,
        iterations: ITER,
        objective: sc.objective,
        event: sc.event,
        towerL1TeleopAllowed: sc.towerL1TeleopAllowed,
        planOverride: { periods: plan.periods, auto: plan.auto, climb: plan.climb },
      });
    rows.push(
      simulateMatch({
        redAlliance: redAll,
        blueAlliance: blueAll,
        redPolicy: mk('red', redAll.robots, blueAll.robots, (sc.seed >>> 0) + 11),
        bluePolicy: mk('blue', blueAll.robots, redAll.robots, (sc.seed >>> 0) + 29),
        scenario: sc,
      }),
    );
  }
  return rows;
}

// Per-side sums over the MATCH set. `stat` names come from the engine's robot bookkeeping; a field that
// does not exist reads 0 rather than throwing, so this keeps working as the engine grows.
function sideTotals(rows, side) {
  const acc = {};
  const add = (k, v) => {
    if (typeof v !== 'number') return;
    acc[k] = (acc[k] || 0) + v;
  };
  for (const res of rows) {
    const f = res.final[side];
    for (const k of ['fuel', 'fuelInactive', 'towerTotal', 'towerAuto', 'towerTeleop', 'foulPoints', 'total', 'corral', 'chute']) add(k, f[k]);
    for (const st of res.robotStats) {
      if (st.alliance !== side) continue;
      for (const k of ['fuelScored', 'fuelCollected', 'fuelWasted', 'shots', 'shotsBlocked', 'blocks', 'activeSec', 'impairedSec', 'collectTicks', 'intakeTicks', 'distanceIn', 'pins', 'fouls', 'foulPoints', 'climbPoints']) add(k, st[k]);
    }
  }
  const n = rows.length;
  for (const k of Object.keys(acc)) acc[k] /= n;
  return acc;
}

const KEYS = [
  'total',
  'fuel',
  'fuelInactive',
  'towerTotal',
  'foulPoints',
  'corral',
  'chute',
  'fuelCollected',
  'fuelScored',
  'fuelWasted',
  'shots',
  'shotsBlocked',
  'blocks',
  'pins',
  'activeSec',
  'impairedSec',
  'distanceIn',
];

for (const t of TRIO_LIST) {
  const trio = t === 0 ? SAMPLES.slice(0, 3) : SAMPLES.slice(3, 6);
  console.log(`\ntrio ${trio.map((p) => p.team).join('/')}  ·  ${MATCHES} MATCHes, seed ${SEED}, plan pinned to all-SCORE both sides`);
  for (const autoWinner of RUNS) {
    const rows = runOnce(trio, autoWinner);
    const R = sideTotals(rows, 'red');
    const B = sideTotals(rows, 'blue');
    const diffs = rows.map((r) => r.final.red.total - r.final.blue.total);
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, diffs.length - 1));
    console.log(`  autoWinner=${autoWinner}   red-blue ${mean.toFixed(1)} +- ${(sd / Math.sqrt(diffs.length)).toFixed(1)} points`);
    console.log(`    ${'metric'.padEnd(16)}${'red'.padStart(9)}${'blue'.padStart(9)}${'R-B'.padStart(9)}`);
    for (const k of KEYS) {
      const r = R[k] || 0;
      const b = B[k] || 0;
      if (!r && !b) continue;
      console.log(`    ${k.padEnd(16)}${r.toFixed(1).padStart(9)}${b.toFixed(1).padStart(9)}${(r - b).toFixed(1).padStart(9)}`);
    }
  }
}
