// Where the AI's shortfall against the greedy baseline actually comes from.
//
// A win rate says which side is ahead and nothing about why. This runs the same MATCHes and prints
// both drivers' production - FUEL collected, scored, wasted, distance travelled - next to their intent
// mixes, so "the AI cycles worse" can be split into "it gathers less" and "it converts less". Those
// have opposite fixes: the first is a FUEL-targeting problem, the second a shooting one.
//
//   node scripts/gap.mjs
//   MATCHES=12 SEED=90001 node scripts/gap.mjs
import { runOneOpponentMatch } from '../web/js/league.js';
import { DEFAULT_WEIGHTS, cloneWeights } from '../web/js/ai.js';
import { INTENT } from '../web/js/engine.js';

const MATCHES = Number(process.env.MATCHES || 4);
const SEED = Number(process.env.SEED || 90001);

const agg = { ai: { c: 0, s: 0, w: 0, d: 0 }, opp: { c: 0, s: 0, w: 0, d: 0 } };
const mix = { ai: new Map(), opp: new Map() };

for (let m = 0; m < MATCHES; m++) {
  const { res, aiSide } = runOneOpponentMatch({
    kind: 'greedy',
    weights: cloneWeights(DEFAULT_WEIGHTS),
    seed: SEED + m * 977,
    iterations: 200,
    aiSide: m % 2 ? 'blue' : 'red',
    record: true,
  });
  for (const s of res.robotStats) {
    const k = s.alliance === aiSide ? 'ai' : 'opp';
    agg[k].c += s.fuelCollected;
    agg[k].s += s.fuelScored;
    agg[k].w += s.fuelWasted;
    agg[k].d += s.distanceIn;
  }
  for (const f of res.timeline || []) {
    for (const r of f.r) {
      const k = r.a === aiSide ? 'ai' : 'opp';
      mix[k].set(r.m, (mix[k].get(r.m) || 0) + 1);
    }
  }
  console.log(`match ${m} (AI ${aiSide}): AI ${res.final[aiSide].total.toFixed(0)} vs OPP ${res.final[aiSide === 'red' ? 'blue' : 'red'].total.toFixed(0)}`);
}

const n = MATCHES * 3;
for (const k of ['ai', 'opp']) {
  const a = agg[k];
  const total = [...mix[k].values()].reduce((x, y) => x + y, 0) || 1;
  const parts = [...mix[k].entries()]
    .sort((p, q) => q[1] - p[1])
    .map(([key, v]) => `${INTENT[key] || key} ${Math.round((100 * v) / total)}%`);
  console.log(
    `${k}: collected ${(a.c / n).toFixed(0)} scored ${(a.s / n).toFixed(0)} (${((100 * a.s) / Math.max(1, a.c)).toFixed(0)}%) wasted ${(a.w / n).toFixed(0)} dist ${(a.d / n).toFixed(0)}in | ${parts.join(' · ')}`,
  );
}
