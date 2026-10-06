// Benchmark: is the search AI actually stronger than competent hand-written baselines?
// Also checks how well the analytic search model tracks the real engine.

import { DEFAULT_WEIGHTS } from '../web/js/ai.js';
import { evaluateVsBaseline, headToHead, BASELINE_KINDS, Elo, fastModelVsEngine } from '../web/js/league.js';

const MATCHES = Number(process.env.MATCHES || 12);
const ITER = Number(process.env.ITER || 160);
const t0 = Date.now();

console.log(`REBUILT AI benchmark - ${MATCHES} matches per pairing, ${ITER} MCTS iterations/decision`);
console.log('weights: defaults (untrained)\n');

const elo = new Elo(24);
const results = [];
for (const kind of BASELINE_KINDS) {
  const r = evaluateVsBaseline({ kind, weights: DEFAULT_WEIGHTS, matches: MATCHES, iterations: ITER, seed: 4000 });
  results.push(r);
  const s = (v) => v.toFixed(1).padStart(6);
  console.log(
    `AI vs ${kind.padEnd(12)} win ${(r.winRate * 100).toFixed(0).padStart(3)}%  (W${r.wins}/L${r.losses}/T${r.ties})  ` +
      `score ${s(r.avgAiScore)} vs ${s(r.avgOppScore)}  RP ${r.avgRP.toFixed(2)}  TRAVERSAL ${(r.traversalRate * 100).toFixed(0)}%  ENERGIZED ${(r.energizedRate * 100).toFixed(0)}%`,
  );
}

console.log('\n--- Elo (AI vs each baseline, iterated over the pairing results) ---');
const aiName = 'AI(default)';
for (const r of results) {
  const games = r.matches;
  for (let g = 0; g < games; g++) {
    const score = g < r.wins ? 1 : g < r.wins + r.ties ? 0.5 : 0;
    elo.record(aiName, r.kind, score);
  }
}
for (const row of elo.table()) console.log(`  ${row.name.padEnd(16)} ${String(row.rating).padStart(4)}  (${row.games} games)`);

console.log('\n--- AI vs greedy head to head, same ROBOT profiles on both ALLIANCES ---');
const hh = headToHead({ kindA: 'ai', kindB: 'greedy', A: DEFAULT_WEIGHTS, B: null, matches: MATCHES, iterations: ITER, seed: 777 });
console.log(`  AI ${hh.aWins} - ${hh.bWins} greedy (draws ${hh.draws}), avg score ${hh.aScore.toFixed(1)} vs ${hh.bScore.toFixed(1)}`);

console.log('\n--- analytic model vs engine (greedy both sides) ---');
const agree = fastModelVsEngine({ samples: 8 });
console.log(
  `  engine RED ${agree.engineRed.toFixed(1)} / BLUE ${agree.engineBlue.toFixed(1)}  ` +
    `model RED ${agree.modelRed.toFixed(1)} / BLUE ${agree.modelBlue.toFixed(1)}  ` +
    `err RED ${agree.errRedPct.toFixed(1)}% / BLUE ${agree.errBluePct.toFixed(1)}%`,
);

console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)} s`);
