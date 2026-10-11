// One evaluation per message. The heavy imports happen once at worker start, so the orchestrator can
// keep a pool warm all night instead of paying module load per MATCH set.
//
// `trace` returns the per-MATCH utilities rather than their mean: a candidate and the incumbent must be
// compared MATCH by MATCH on identical seeds, and the only way to get a standard error for the
// difference is to keep the difference of each pair.

import { parentPort } from 'node:worker_threads';
import { fitnessTrace, headToHead, evaluateVsBaseline } from '../web/js/league.js';

parentPort.on('message', (m) => {
  try {
    if (m.job === 'trace') {
      const trace = fitnessTrace({
        weights: m.weights,
        matches: m.matches,
        seed: m.seed,
        iterations: m.iterations,
        families: m.families,
      });
      parentPort.postMessage({ id: m.id, ok: true, trace });
      return;
    }
    if (m.job === 'h2h') {
      const r = headToHead({ kindA: 'ai', kindB: 'ai', A: m.A, B: m.B, matches: m.matches, seed: m.seed, iterations: m.iterations });
      parentPort.postMessage({ id: m.id, ok: true, h2h: r });
      return;
    }
    if (m.job === 'vsGreedy') {
      const r = evaluateVsBaseline({ kind: 'greedy', weights: m.weights, matches: m.matches, seed: m.seed, iterations: m.iterations });
      parentPort.postMessage({ id: m.id, ok: true, vsGreedy: r });
      return;
    }
    throw new Error(`unknown job ${m.job}`);
  } catch (err) {
    parentPort.postMessage({ id: m.id, ok: false, error: String((err && err.stack) || err) });
  }
});
