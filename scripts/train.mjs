// Offline self-play weight tuning, with a holdout gate.
//
// The browser trainer is budget-limited and overfits; anything it produces is measured on the same
// seeds it was trained on. This script separates the two: evolve on one seed family, then decide
// whether to ship by playing the candidate against the shipped defaults on seeds it has never seen.
// A candidate only gets written back if it wins that A/B.

import { DEFAULT_WEIGHTS, WEIGHT_KEYS } from '../web/js/ai.js';
import { evolve, headToHead, evaluateVsBaseline } from '../web/js/league.js';

const BUDGET_MS = Number(process.env.BUDGET_MS || 90000);
const ITER = Number(process.env.ITER || 140);
const TRAIN_SEED = 90001;
const HOLDOUT_SEED = 700001;
const HOLDOUT_MATCHES = Number(process.env.HOLDOUT_MATCHES || 30);

const fmt = (v, d = 1) => v.toFixed(d).padStart(6);

console.log('REBUILT offline self-play tuning');
console.log(`  train seed ${TRAIN_SEED} / holdout seed ${HOLDOUT_SEED} (disjoint), budget ${(BUDGET_MS / 1000).toFixed(0)}s\n`);

const t0 = Date.now();
const { weights: cand, history } = evolve({
  initial: DEFAULT_WEIGHTS,
  generations: 400,
  lambda: 10,
  matches: 8,
  seed: TRAIN_SEED,
  iterations: ITER,
  budgetMs: BUDGET_MS,
  selfPlay: true,
});

const gens = history.length - 1;
console.log(`evolved ${gens} generations in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`  train fitness  start ${history[0].fit.toFixed(3)}  ->  end ${history[history.length - 1].fit.toFixed(3)}`);

console.log('\n--- holdout: vs the hand-written baselines (seeds never used in training) ---');
const vs = {};
for (const kind of ['random', 'shootalways', 'greedy']) {
  const a = evaluateVsBaseline({ kind, weights: DEFAULT_WEIGHTS, matches: HOLDOUT_MATCHES, seed: HOLDOUT_SEED, iterations: ITER });
  const b = evaluateVsBaseline({ kind, weights: cand, matches: HOLDOUT_MATCHES, seed: HOLDOUT_SEED, iterations: ITER });
  vs[kind] = { a, b };
  console.log(
    `  ${kind.padEnd(12)} shipped ${(a.winRate * 100).toFixed(0).padStart(3)}%  ${fmt(a.avgAiScore)} vs ${fmt(a.avgOppScore)}` +
      `   |   candidate ${(b.winRate * 100).toFixed(0).padStart(3)}%  ${fmt(b.avgAiScore)} vs ${fmt(b.avgOppScore)}`,
  );
}

console.log('\n--- holdout: candidate vs shipped, head to head on identical ROBOTs ---');
const ab = headToHead({
  kindA: 'ai',
  kindB: 'ai',
  A: cand,
  B: DEFAULT_WEIGHTS,
  matches: HOLDOUT_MATCHES * 2,
  iterations: ITER,
  seed: HOLDOUT_SEED + 555,
});
console.log(`  candidate ${ab.aWins} - ${ab.bWins} shipped (draws ${ab.draws}), avg ${ab.aScore.toFixed(1)} vs ${ab.bScore.toFixed(1)}`);

const greedyOk = vs.greedy.b.winRate >= vs.greedy.a.winRate - 0.03;
const abWin = ab.aWins > ab.bWins;
const abScore = ab.aScore > ab.bScore;
const ship = greedyOk && abWin && abScore;

console.log('\n--- verdict ---');
console.log(`  greedy holdout not worse: ${greedyOk ? 'yes' : 'NO'}`);
console.log(`  head-to-head wins:        ${abWin ? 'yes' : 'NO'} (${ab.aWins} vs ${ab.bWins})`);
console.log(`  head-to-head score:       ${abScore ? 'yes' : 'NO'} (${ab.aScore.toFixed(1)} vs ${ab.bScore.toFixed(1)})`);
console.log(`  => ${ship ? 'SHIP the candidate weights' : 'KEEP the shipped defaults'}`);

const changed = WEIGHT_KEYS.filter((k) => Math.abs(cand[k] - DEFAULT_WEIGHTS[k]) > 1e-9);
console.log(`\nchanged weights (${changed.length}/${WEIGHT_KEYS.length}):`);
for (const k of changed) {
  console.log(`  ${k.padEnd(24)} ${String(DEFAULT_WEIGHTS[k]).padStart(8)}  ->  ${cand[k].toFixed(4)}`);
}

if (ship) {
  console.log('\n--- paste into DEFAULT_WEIGHTS in web/js/ai.js ---');
  for (const k of WEIGHT_KEYS) console.log(`  ${k}: ${Number(cand[k].toFixed(4))},`);
}
