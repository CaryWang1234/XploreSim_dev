// Knob sweeps on the greedy same-roster mirror, which is what every "the anchor would move by X" figure
// in the calibration table and the README was measured with.
//
// Those figures used to come from a scratch script that was never committed, and mirror.mjs's own header
// says what that costs: a number nobody can re-run is not evidence. The harness is deliberately small — it
// runs one policy pair, both trios, both seed sets, and changes exactly one scenario field at a time, so
// the only thing moving between printed points is the knob.
//
//   node scripts/knob.mjs
//   KNOB=hubExitLateralIn VALS=100,150 node scripts/knob.mjs
//   KNOB=blockStopAtBumper VALS=0,1 EXTRA='{"blockAboveOpening":0}' node scripts/knob.mjs
//
// EXTRA is a JSON object merged before KNOB, for the rules that only make sense switched off together.
// N is MATCHes per seed set per trio, so the default prints 96 MATCHes = 192 ALLIANCE scores per point.
// Note the scale: this averages BOTH rosters, so its mean sits about 16 points under the 254/1678/1690
// anchor that scripts/mirror.mjs prints as the calibration figure.

import { simulateMatch } from '../web/js/engine.js';
import { defaultScenario, makeAlliance, SAMPLES } from '../web/js/model.js';
import { greedyPolicy } from '../web/js/league.js';

const N = Number(process.env.N || 24);
const VALS = (process.env.VALS || '4.2,4.6,5.0,5.2').split(',').map(Number);
const KNOB = process.env.KNOB || 'hubExitRate';
const SEEDS = [20260110, 88101];
const EXTRA = process.env.EXTRA ? JSON.parse(process.env.EXTRA) : {};

for (const value of VALS) {
  let sum = 0;
  let n = 0;
  const gaps = [];
  for (const seed of SEEDS) {
    for (const trio of [SAMPLES.slice(0, 3), SAMPLES.slice(3, 6)]) {
      for (let i = 0; i < N; i++) {
        const sc = { ...defaultScenario(), seed: (seed + i * 7919) >>> 0, faultsEnabled: true, ...EXTRA, [KNOB]: value };
        const res = simulateMatch({
          redAlliance: makeAlliance(trio, 'red'),
          blueAlliance: makeAlliance(trio, 'blue'),
          redPolicy: greedyPolicy('red'),
          bluePolicy: greedyPolicy('blue'),
          scenario: sc,
        });
        sum += res.final.red.total + res.final.blue.total;
        n += 2;
        gaps.push(res.final.red.total - res.final.blue.total);
      }
    }
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (gaps.length - 1));
  console.log(`${KNOB} ${value}  ${n} ALLIANCE scores  mean ${(sum / n).toFixed(1)}   red-blue ${mean.toFixed(1)} +- ${(sd / Math.sqrt(gaps.length)).toFixed(1)}`);
}
