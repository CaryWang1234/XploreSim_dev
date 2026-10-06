// Web Worker: keeps Monte-Carlo prediction and self-play training off the UI thread so the field
// animation stays smooth. Communicates with plain structured messages.

import { DEFAULT_WEIGHTS } from './ai.js';
import { monteCarlo } from './mc.js';
import { evolve, evaluateVsBaseline, headToHead, calibrateModel, fastModelVsEngine } from './league.js';

self.onmessage = (ev) => {
  const { id, type, payload } = ev.data || {};
  try {
    if (type === 'calibrate') {
      const c = calibrateModel({ weights: payload && payload.weights, samples: (payload && payload.samples) || 4 });
      self.postMessage({ id, type: 'result', payload: c });
      return;
    }
    if (type === 'mc') {
      const res = monteCarlo({
        ...payload,
        onProgress: (p) => self.postMessage({ id, type: 'progress', payload: p }),
      });
      const { recorded, ...rest } = res;
      self.postMessage({
        id,
        type: 'result',
        payload: rest,
        timeline: recorded ? recorded.timeline : null,
        final: recorded ? recorded.final : null,
        hubSchedule: recorded ? recorded.hubSchedule : null,
        autoFuel: recorded ? recorded.autoFuel : null,
        autoWinner: recorded ? recorded.autoWinner : null,
        robotStats: recorded ? recorded.robotStats : null,
        events: recorded ? recorded.events : null,
        planSnapshot: payload.planSnapshot || null,
      });
      return;
    }

    if (type === 'train') {
      const out = evolve({
        initial: payload.weights || DEFAULT_WEIGHTS,
        generations: payload.generations || 12,
        lambda: payload.lambda || 6,
        matches: payload.matches || 4,
        iterations: payload.iterations || 120,
        budgetMs: payload.budgetMs || 30000,
        selfPlay: payload.selfPlay !== false,
        seed: payload.seed || 99,
        onProgress: (p) => self.postMessage({ id, type: 'progress', payload: { gen: p.gen, generations: p.generations, fit: p.fit, sigma: p.sigma } }),
      });
      self.postMessage({ id, type: 'result', payload: { weights: out.weights, fitness: out.fitness, history: out.history } });
      return;
    }

    if (type === 'benchmark') {
      const { weights, matches = 8, iterations = 140 } = payload || {};
      const rows = [];
      for (const kind of ['random', 'shootalways', 'greedy']) {
        rows.push(evaluateVsBaseline({ kind, weights, matches, iterations, seed: 4000 }));
        self.postMessage({ id, type: 'progress', payload: { stage: kind } });
      }
      const hh = headToHead({ kindA: 'ai', kindB: 'greedy', A: weights, B: null, matches, iterations, seed: 777 });
      const agreement = fastModelVsEngine({ samples: 6, weights });
      self.postMessage({ id, type: 'result', payload: { rows, headToHead: hh, agreement } });
      return;
    }

    self.postMessage({ id, type: 'error', payload: `unknown worker message: ${type}` });
  } catch (err) {
    self.postMessage({ id, type: 'error', payload: String((err && err.stack) || err) });
  }
};
