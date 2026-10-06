// Deterministic, seedable RNG so every simulation and every Monte Carlo run is reproducible.
// mulberry32: small, fast, good enough for game simulation and MCTS rollouts.

export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (n) => Math.floor(rng() * n);
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  rng.gauss = (mean = 0, sd = 1) => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  // Dirichlet sample (used by the opponent-model Bayesian update).
  rng.dirichlet = (alpha) => {
    const g = alpha.map((a) => gammaSample(rng, a, 1));
    const s = g.reduce((x, y) => x + y, 0);
    return g.map((x) => x / s);
  };
  return rng;
}

function gammaSample(rng, shape, scale) {
  if (shape < 1) {
    const u = rng();
    return gammaSample(rng, shape + 1, scale) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = rng.gauss();
    const v = 1 + c * x;
    if (v <= 0) continue;
    const v3 = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v3 * scale;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v3 + Math.log(v3))) return d * v3 * scale;
  }
}

export function hashSeed(...nums) {
  let h = 2166136261 >>> 0;
  for (const n of nums) {
    const v = typeof n === 'number' ? Math.round(n * 1000) : String(n).split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    h ^= v >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
