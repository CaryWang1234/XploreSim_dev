// Offline self-play weight tuning, with a holdout gate.
//
// The browser trainer is budget-limited and overfits; anything it produces is measured on the same
// seeds it was trained on. This script separates the two: evolve on one seed family, then decide
// whether to ship by playing the candidate against the shipped defaults on seeds it has never seen.
// A candidate only gets written back if it wins that A/B.
//
// The noise floor is printed first, because it decides whether the run can conclude anything. The
// fitness of the SAME weights varies by ~0.4 across seed sets at the default 8 MATCHes per
// evaluation, while a single weight's true effect is nearer 0.1: at that ratio a short run is
// selecting on luck. MATCHES and KEYS are the two knobs that fix it — more MATCHes per evaluation,
// fewer axes to move.

import { DEFAULT_WEIGHTS, WEIGHT_KEYS, cloneWeights } from '../web/js/ai.js';
import { evolve, headToHead, evaluateVsBaseline, fitness } from '../web/js/league.js';

const BUDGET_MS = Number(process.env.BUDGET_MS || 90000);
const ITER = Number(process.env.ITER || 140);
const MATCHES = Number(process.env.MATCHES || 8);
const LAMBDA = Number(process.env.LAMBDA || 10);
const TRAIN_SEED = 90001;
const HOLDOUT_SEED = 700001;
const HOLDOUT_MATCHES = Number(process.env.HOLDOUT_MATCHES || 30);
const FAMILIES = (process.env.FAMILIES || `${HOLDOUT_SEED},300001`).split(',').map((x) => Number(x.trim()));
// Comma-separated subset of WEIGHT_KEYS; empty means the whole vector.
const KEYS = (process.env.KEYS || '').split(',').map((s) => s.trim()).filter(Boolean);
// How many disjoint seed families each evaluation spreads its MATCHes over. 1 is the old behaviour
// and it does not transfer: the training family is a fixed set of FUEL layouts, and a search run on
// one family buys that family rather than the game.
const TRAIN_FAMILIES = Number(process.env.TRAIN_FAMILIES || 4);
// `selfPlay=1` scores half the MATCHes candidate-vs-incumbent. It is the gameable half: the run that
// used it gained +0.9 fitness inside its training family and then lost 40 points a MATCH head to head
// on seeds it had never seen, because beating your own parent is not the same as beating the field.
const SELF_PLAY = process.env.SELFPLAY === '1';
const unknown = KEYS.filter((k) => !WEIGHT_KEYS.includes(k));
if (unknown.length) throw new Error(`unknown weight(s): ${unknown.join(', ')}`);

const fmt = (v, d = 1) => v.toFixed(d).padStart(6);
const pad = (s, n) => String(s).padEnd(n);

console.log('REBUILT offline self-play tuning');
console.log(`  train seed ${TRAIN_SEED} / holdout families ${FAMILIES.join(', ')} (disjoint), budget ${(BUDGET_MS / 1000).toFixed(0)}s`);
console.log(`  ${MATCHES} MATCHes per evaluation over ${TRAIN_FAMILIES} seed famil${TRAIN_FAMILIES === 1 ? 'y' : 'ies'}, lambda ${LAMBDA}, iterations ${ITER}, ${KEYS.length ? KEYS.length + ' movable weight(s)' : 'all ' + WEIGHT_KEYS.length + ' weights'}, self-play ${SELF_PLAY ? 'on' : 'off'}`);

// Noise floor: the same weights, six seed sets. An "improvement" smaller than this is not one.
{
  const t = Date.now();
  const vals = [];
  for (let s = 0; s < 6; s++) vals.push(fitness({ weights: DEFAULT_WEIGHTS, matches: MATCHES, seed: TRAIN_SEED + s * 31, iterations: ITER, families: TRAIN_FAMILIES }));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  console.log(
    `\nnoise floor: shipped weights score ${mean.toFixed(2)} +- ${sd.toFixed(2)} across six seed sets` +
      ` (${((Date.now() - t) / 6000).toFixed(1)}s per evaluation).`,
  );
  console.log(`  a generation's fitness gain below ~${sd.toFixed(2)} is inside this spread, not a finding.`);
}

const t0 = Date.now();
const { weights: cand, history } = evolve({
  initial: DEFAULT_WEIGHTS,
  generations: 400,
  lambda: LAMBDA,
  matches: MATCHES,
  seed: TRAIN_SEED,
  iterations: ITER,
  budgetMs: BUDGET_MS,
  selfPlay: SELF_PLAY,
  keys: KEYS,
  families: TRAIN_FAMILIES,
});

const gens = history.length - 1;
console.log(`evolved ${gens} generations in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`  train fitness  start ${history[0].fit.toFixed(3)}  ->  end ${history[history.length - 1].fit.toFixed(3)}`);

console.log('\n--- holdout: vs the hand-written baselines, per seed family (never used in training) ---');
const vs = {};
for (const kind of ['random', 'shootalways', 'greedy']) {
  const perFamily = [];
  for (const family of FAMILIES) {
    const a = evaluateVsBaseline({ kind, weights: DEFAULT_WEIGHTS, matches: HOLDOUT_MATCHES, seed: family, iterations: ITER });
    const b = evaluateVsBaseline({ kind, weights: cand, matches: HOLDOUT_MATCHES, seed: family, iterations: ITER });
    perFamily.push({ family, a, b });
    console.log(
      `  ${kind.padEnd(12)} ${pad(family, 8)} shipped ${(a.winRate * 100).toFixed(1).padStart(5)}%  ${fmt(a.avgAiScore)} vs ${fmt(a.avgOppScore)}` +
        `   |   candidate ${(b.winRate * 100).toFixed(1).padStart(5)}%  ${fmt(b.avgAiScore)} vs ${fmt(b.avgOppScore)}` +
        `   d(score) ${fmt(b.avgAiScore - a.avgAiScore)}  d(margin) ${fmt(b.avgAiScore - b.avgOppScore - (a.avgAiScore - a.avgOppScore))}`,
    );
  }
  const mean = (pick) => perFamily.reduce((s, r) => s + pick(r), 0) / perFamily.length;
  const sdOf = (pick) => {
    const m = mean(pick);
    return Math.sqrt(perFamily.reduce((s, r) => s + (pick(r) - m) ** 2, 0) / perFamily.length);
  };
  const dWin = (r) => r.b.winRate - r.a.winRate;
  const dMargin = (r) => r.b.avgAiScore - r.b.avgOppScore - (r.a.avgAiScore - r.a.avgOppScore);
  vs[kind] = {
    dWin: mean(dWin),
    dWinSe: sdOf(dWin) / Math.sqrt(perFamily.length),
    dMargin: mean(dMargin),
    dMarginSe: sdOf(dMargin) / Math.sqrt(perFamily.length),
  };
  console.log(
    `  ${''.padEnd(12)} ${pad('pooled', 8)} win ${(vs[kind].dWin * 100 >= 0 ? '+' : '') + (vs[kind].dWin * 100).toFixed(1)} pts (se ${(vs[kind].dWinSe * 100).toFixed(1)})` +
      `   margin ${vs[kind].dMargin >= 0 ? '+' : ''}${vs[kind].dMargin.toFixed(1)} (se ${vs[kind].dMarginSe.toFixed(1)})`,
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

// A candidate has to clear the noise it was selected under, not just point the right way: `2 se`
// on the paired margin is the threshold, and the head-to-head has to agree. A single seed family
// has no spread to compute, so it can never express the threshold and the gate stays shut.
const g = vs.greedy;
const marginClears = FAMILIES.length >= 2 && g.dMargin > 2 * g.dMarginSe;
const greedyOk = g.dWin >= -Math.max(0.03, g.dWinSe);
const abWin = ab.aWins > ab.bWins;
const abScore = ab.aScore > ab.bScore;
const ship = greedyOk && marginClears && abWin && abScore;

console.log('\n--- verdict ---');
console.log(`  greedy holdout not worse:      ${greedyOk ? 'yes' : 'NO'}`);
console.log(`  margin beats the noise floor:  ${marginClears ? 'yes' : 'NO'} (${g.dMargin >= 0 ? '+' : ''}${g.dMargin.toFixed(1)} vs 2 se = ${(2 * g.dMarginSe).toFixed(1)})`);
console.log(`  head-to-head wins:             ${abWin ? 'yes' : 'NO'} (${ab.aWins} vs ${ab.bWins})`);
console.log(`  head-to-head score:            ${abScore ? 'yes' : 'NO'} (${ab.aScore.toFixed(1)} vs ${ab.bScore.toFixed(1)})`);
console.log(`  => ${ship ? 'SHIP the candidate weights' : 'KEEP the shipped defaults'}`);
if (!marginClears && g.dMargin > 0) {
  console.log('     (the candidate points the right way but the effect is smaller than the seed-to-seed spread:');
  console.log('      more MATCHes per evaluation, or fewer KEYS, is what would settle it.)');
}

const changed = WEIGHT_KEYS.filter((k) => Math.abs(cand[k] - DEFAULT_WEIGHTS[k]) > 1e-9);
console.log(`\nchanged weights (${changed.length}/${WEIGHT_KEYS.length}):`);
for (const k of changed) {
  console.log(`  ${k.padEnd(24)} ${String(DEFAULT_WEIGHTS[k]).padStart(8)}  ->  ${cand[k].toFixed(4)}`);
}

if (ship) {
  console.log('\n--- paste into DEFAULT_WEIGHTS in web/js/ai.js ---');
  for (const k of WEIGHT_KEYS) console.log(`  ${k}: ${Number(cand[k].toFixed(4))},`);
}
