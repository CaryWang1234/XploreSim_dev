// Overnight weight search, sized by the two things the daytime tuning could not afford.
//
// Why the short runs kept failing: at 8 MATCHes per evaluation the seed-to-seed spread of the SAME
// weights is +-0.3~0.5 while one weight's real effect is nearer 0.1, so the acceptance test was
// selecting on luck. Two changes here, and they are the point of the file:
//
//   1. PAIRED comparisons. The candidate and the incumbent play the identical MATCH set (same seeds,
//      same layouts, same trios, same seats) and the difference is taken MATCH by MATCH. Layout luck
//      cancels, and what is left has a standard error the search can actually trust.
//   2. 150 MATCHes per evaluation over 2 disjoint seed families, which is roughly the sample the
//      earlier note said was needed to resolve a 0.1 effect.
//
// Compute comes from worker_threads across every core. Nothing is written back to web/js/ai.js: the
// run ends with a gate on seed families it never touched and a verdict in .tmp/night/report.md.
//
// Two arms run concurrently so the night answers its own question. Arm A is a coordinate pattern
// search over the axes, seeded by named hypotheses that come from measurements already in this repo.
// Arm B is the old blind random-mutation hill climb, same sample size, same number of cores. If A
// finds nothing either, the local optimum is real; if A finds something and B does not, the method was
// the limit rather than the compute.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { DEFAULT_WEIGHTS, WEIGHT_KEYS, WEIGHT_BOUNDS, cloneWeights } from '../web/js/ai.js';
import { FAMILY_STRIDE, makeRng } from '../web/js/league.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const OUT_DIR = process.env.OUT_DIR || path.join(ROOT, '.tmp', 'night');
fs.mkdirSync(OUT_DIR, { recursive: true });

const CORES = Number(process.env.CORES || os.cpus().length);
const MATCHES = Number(process.env.MATCHES || 150);
const FAM = Number(process.env.FAMILIES || 2);
const ITER = Number(process.env.ITER || 140);
const LAMBDA = Number(process.env.LAMBDA || Math.max(2, Math.floor(CORES / 2)));
const Z_ACCEPT = Number(process.env.Z_ACCEPT || 2.0);
const Z_CONFIRM = Number(process.env.Z_CONFIRM || 1.0);
const GATE_MATCHES = Number(process.env.GATE_MATCHES || 150);
const HOURS = Number(process.env.HOURS || 0);
const RESERVE_MS = Number(process.env.RESERVE_MIN || 25) * 60_000;

const TRAIN_BASE_A = 90_001;
const TRAIN_BASE_B = 300_007;
const CONFIRM_OFFSET = 5_000_000;

const LOG = path.join(OUT_DIR, 'log.txt');
const EVENTS = path.join(OUT_DIR, 'events.jsonl');
const STATE = path.join(OUT_DIR, 'state.json');
const PROGRESS = path.join(OUT_DIR, 'progress.md');
const REPORT = path.join(OUT_DIR, 'report.md');

const startedAt = new Date();
function deadline() {
  if (HOURS > 0) return Date.now() + HOURS * 3_600_000 + RESERVE_MS;
  const t = new Date();
  t.setHours(5, 20, 0, 0);
  if (t.getTime() <= startedAt.getTime() + RESERVE_MS) t.setDate(t.getDate() + 1);
  return t.getTime();
}
const HARD_END = deadline();
const SEARCH_END = HARD_END - RESERVE_MS;

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('en-GB')}] ${msg}\n`;
  fs.appendFileSync(LOG, line, 'utf8');
  process.stdout.write(line);
}

// ---------------------------------------------------------------------------
// worker pool
// ---------------------------------------------------------------------------
class Pool {
  constructor(n) {
    this.idle = [];
    this.queue = [];
    this.pending = new Map();
    this.seq = 0;
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./night_worker.mjs', import.meta.url));
      w.on('message', (m) => {
        const wait = this.pending.get(m.id);
        this.pending.delete(m.id);
        this.idle.push(w);
        if (!wait) return;
        if (m.ok) wait.res(m);
        else wait.rej(new Error(m.error));
        this.pump();
      });
      w.on('error', (e) => log(`worker error: ${e && e.message}`));
      this.idle.push(w);
    }
  }

  run(job) {
    return new Promise((res, rej) => {
      const id = ++this.seq;
      this.pending.set(id, { res, rej });
      this.queue.push({ ...job, id });
      this.pump();
    });
  }

  pump() {
    while (this.idle.length && this.queue.length) {
      this.idle.pop().postMessage(this.queue.shift());
    }
  }

  // The result carries the payload under its job name; unwrap it so callers get values, not envelopes.
  // `mark: false` keeps the gate's layouts out of the searched set, so both arms are judged on the
  // same unseen MATCHes and the reported "layouts touched by search" stays what it says.
  async trace(weights, seed, matches = MATCHES, families = FAM, mark = true) {
    if (mark) markTrace(seed, matches, families);
    const m = await this.run({ job: 'trace', weights, seed, matches, families, iterations: ITER });
    return m.trace;
  }

  async h2h(A, B, matches, seed) {
    const m = await this.run({ job: 'h2h', A, B, matches, seed, iterations: ITER });
    return m.h2h;
  }

  async vsGreedy(weights, matches, seed) {
    const m = await this.run({ job: 'vsGreedy', weights, matches, seed, iterations: ITER });
    return m.vsGreedy;
  }
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------
function paired(a, b) {
  const n = Math.min(a.length, b.length);
  const d = new Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) {
    d[i] = a[i] - b[i];
    s += d[i];
  }
  const mean = s / n;
  let v = 0;
  for (const x of d) v += (x - mean) ** 2;
  const sd = Math.sqrt(v / Math.max(1, n - 1));
  return { n, mean, se: sd / Math.sqrt(n), sd };
}

const fmt = (o, d = 3) => `${o.mean >= 0 ? '+' : ''}${o.mean.toFixed(d)}±${o.se.toFixed(d)}`;

// Every layout seed the search touches is recorded so the gate can prove it plays none of them.
const usedSeeds = new Set();
function markTrace(seed, matches = MATCHES, families = FAM) {
  const fams = Math.max(1, Math.min(families, matches));
  for (let i = 0; i < matches; i++) usedSeeds.add((seed + (i % fams) * FAMILY_STRIDE + Math.floor(i / fams) * 613) >>> 0);
}
function traceLayout(seed, matches, families) {
  const fams = Math.max(1, Math.min(families, matches));
  const out = [];
  for (let i = 0; i < matches; i++) out.push((seed + (i % fams) * FAMILY_STRIDE + Math.floor(i / fams) * 613) >>> 0);
  return out;
}
function greedyLayout(seed, matches) {
  const out = [];
  for (let i = 0; i < matches; i++) out.push((seed + i * 977) >>> 0);
  return out;
}
function h2hLayout(seed, matches) {
  const out = [];
  for (let i = 0; i < matches; i++) out.push((seed + i * 613) >>> 0);
  return out;
}
function freshBase(kind, matches, families, from) {
  const taken = new Set([...usedSeeds]);
  for (let base = from; base < from + 200_000; base += 9973) {
    const seeds = kind === 'trace' ? traceLayout(base, matches, families) : kind === 'greedy' ? greedyLayout(base, matches) : h2hLayout(base, matches);
    if (seeds.every((s) => !taken.has(s))) {
      for (const s of seeds) taken.add(s);
      return base;
    }
  }
  throw new Error(`no disjoint ${kind} seed base found`);
}

// ---------------------------------------------------------------------------
// phase -1: is the knob connected to anything at all
// ---------------------------------------------------------------------------
// Driving each axis to both ends of its domain and asking whether ANY MATCH finishes differently costs
// one evaluation per axis and answers a question the daytime runs never asked: a weight whose two
// extremes produce byte-identical per-MATCH utilities is not a strategy dial, it is a number the search
// would spend a generation on. (The engine is deterministic, so a real behaviour change flips at least
// one MATCH — a zero here means the branch never became reachable in the sampled play.)
async function probeAxes(pool) {
  const shipped = cloneWeights(DEFAULT_WEIGHTS);
  const seed = TRAIN_BASE_A - 7;
  const base = await pool.trace(shipped, seed);
  const rows = await Promise.all(
    WEIGHT_KEYS.map(async (k) => {
      const b = WEIGHT_BOUNDS[k] || [Math.max(0, shipped[k] * 0.4 - 0.05), shipped[k] * 2 + 0.05];
      const hi = shipped[k] !== b[1] ? b[1] : b[0];
      const lo = shipped[k] !== b[0] ? b[0] : b[1];
      const [th, tl] = await Promise.all([pool.trace(cloneWeights({ ...shipped, [k]: hi }), seed), pool.trace(cloneWeights({ ...shipped, [k]: lo }), seed)]);
      const dev = (t) => t.reduce((m, v, i) => Math.max(m, Math.abs(v - base[i])), 0);
      const spread = Math.max(dev(th), dev(tl));
      return { key: k, spread, inert: spread === 0 };
    }),
  );
  const inert = rows.filter((r) => r.inert).map((r) => r.key);
  log(`phase -1: ${inert.length}/${rows.length} knobs change no MATCH at either end of their domain${inert.length ? ` (${inert.join(', ')})` : ''}`);
  return rows;
}

// ---------------------------------------------------------------------------
// phase 0: named hypotheses (a joint move on two axes is something coordinate descent rarely finds)
// ---------------------------------------------------------------------------
const HYPOTHESES = [
  // The measured verdict was that defence is real but only half-priced: the model charges the opponent
  // for the defender and not the defender's own side for the bank it gives up. bankCredit is that cost.
  { label: 'defenceFullLedger', patch: { defenseEfficacy: 0.1, bankCredit: 0.45 } },
  // The AI's cycling tempo already beat greedy's, but it fills a whole hopper before dumping.
  { label: 'smallLoadsEarlyDump', patch: { dumpThreshold: 0.35, dumpBeforeIdleSec: 4.5 } },
  // mateSeparation was worth 7.3 win points going from 0 to 0.6; the sweep stopped there.
  { label: 'spreadHarder', patch: { mateSeparation: 1.2 } },
  { label: 'widerSearch', patch: { mctsExploration: 1.25 } },
  // Relaxing the auto pass cut the win rate hard, so the other direction is the open one.
  { label: 'tighterPass', patch: { passWhenFarFrac: 0.95 } },
  { label: 'laterPrep', patch: { darkPrepSec: 6 } },
  { label: 'looserPileSticking', patch: { clusterStickiness: 0.45, targetRefreshSec: 0.9 } },
  { label: 'pressEarlier', patch: { pressWhenIdleFrac: 0.65 } },
];

async function screenHypotheses(pool) {
  log(`phase 0: screening ${HYPOTHESES.length} named hypotheses at ${MATCHES} MATCHes/arm, paired`);
  const seedA = TRAIN_BASE_A + 11 * 31;
  const seedB = seedA + CONFIRM_OFFSET;
  const shipped = cloneWeights(DEFAULT_WEIGHTS);
  // All the hypotheses go on the queue at once: one at a time would idle most of the cores for a
  // phase whose whole job is to pick a starting vector.
  const [baseA, baseB, ...rest] = await Promise.all([
    pool.trace(shipped, seedA),
    pool.trace(shipped, seedB),
    ...HYPOTHESES.flatMap((h) => {
      const w = cloneWeights({ ...shipped, ...h.patch });
      return [pool.trace(w, seedA), pool.trace(w, seedB)];
    }),
  ]);
  const results = [];
  for (let i = 0; i < HYPOTHESES.length; i++) {
    const h = HYPOTHESES[i];
    const w = cloneWeights({ ...shipped, ...h.patch });
    const train = paired(rest[i * 2], baseA);
    const confirm = paired(rest[i * 2 + 1], baseB);
    const verdict =
      train.mean > Z_ACCEPT * train.se && confirm.mean > Z_CONFIRM * confirm.se && confirm.mean > 0
        ? 'clears'
        : train.mean < -Z_ACCEPT * train.se
          ? 'fails'
          : 'inside noise';
    results.push({ label: h.label, patch: h.patch, train, confirm, verdict, weights: w });
    log(`  ${h.label.padEnd(22)} train ${fmt(train)}  confirm ${fmt(confirm)}  -> ${verdict}`);
  }
  const winners = results.filter((r) => r.verdict === 'clears').sort((a, b) => b.confirm.mean - a.confirm.mean);
  return { results, start: winners.length ? winners[0].weights : shipped, best: winners[0] || null };
}

// ---------------------------------------------------------------------------
// proposers
// ---------------------------------------------------------------------------
const widthOf = (k) => (WEIGHT_BOUNDS[k] ? WEIGHT_BOUNDS[k][1] - WEIGHT_BOUNDS[k][0] : Math.abs(DEFAULT_WEIGHTS[k]) || 1);
const clampAxis = (k, v) => {
  const b = WEIGHT_BOUNDS[k];
  return b ? Math.max(b[0], Math.min(b[1], v)) : v;
};

function makePatternProposer(axes) {
  const step = {};
  for (const k of axes) step[k] = 0.12 * widthOf(k);
  // The floor is 2% of the domain, not 1%: below that a step is smaller than the paired test can see
  // at this sample size, so probing it is not a measurement. The shrink is 0.75 per failed round
  // because 0.55 walked every axis to the floor in under ten generations, and the arm then reported
  // "converged" having barely swept its own neighbourhood — that read as a result and it was not one.
  const floorOf = (k) => 0.02 * widthOf(k);
  let ptr = 0;
  return {
    kind: 'pattern',
    propose(cur) {
      const out = [];
      let guard = 0;
      while (out.length < LAMBDA && guard < axes.length * 2) {
        const k = axes[ptr++ % axes.length];
        guard++;
        if (step[k] <= floorOf(k)) continue;
        for (const dir of [1, -1]) {
          if (out.length >= LAMBDA) break;
          const w = cloneWeights(cur);
          w[k] = clampAxis(k, w[k] + dir * step[k]);
          if (Math.abs(w[k] - cur[k]) < 1e-12) continue;
          out.push({ label: `${k}${dir > 0 ? '+' : '-'}${step[k].toFixed(4)}`, key: k, weights: w });
        }
      }
      return out;
    },
    onAccept(c) {
      step[c.key] = Math.min(0.4 * widthOf(c.key), step[c.key] * 1.25);
    },
    onFailure(cands) {
      for (const c of cands) step[c.key] = Math.max(floorOf(c.key), step[c.key] * 0.75);
    },
    // Pattern search has a real stopping rule: every axis has been probed at both signs of the
    // smallest step worth probing. Anything else is still a sweep in progress.
    exhausted() {
      return axes.every((k) => step[k] <= floorOf(k) + 1e-12);
    },
    describe: () => Object.entries(step).map(([k, v]) => `${k}:${((v / widthOf(k)) * 100).toFixed(1)}%`),
  };
}

function makeMutationProposer(seed, axes) {
  const rnd = makeRng(seed);
  let sigma = 0.25;
  return {
    kind: 'mutation',
    propose(cur) {
      const out = [];
      for (let j = 0; j < LAMBDA; j++) {
        const w = cloneWeights(cur);
        const nMut = 1 + Math.floor(rnd() * 4);
        const touched = [];
        for (let m = 0; m < nMut; m++) {
          const key = axes[Math.floor(rnd() * axes.length)];
          const scale = Math.max(0.05, Math.abs(cur[key]) || 1);
          w[key] = clampAxis(key, w[key] + (rnd() < 0.5 ? -1 : 1) * sigma * scale * (0.4 + rnd()));
          touched.push(key);
        }
        out.push({ label: `mut[${touched.join(',')}]@${sigma.toFixed(3)}`, key: touched[0], weights: cloneWeights(w) });
      }
      return out;
    },
    onAccept() {
      sigma = Math.min(0.6, sigma * 1.08);
    },
    onFailure() {
      sigma = Math.max(0.03, sigma * 0.82);
    },
    exhausted: () => false,
    describe: () => [`sigma:${sigma.toFixed(3)}`],
  };
}

// ---------------------------------------------------------------------------
// one arm of the search
// ---------------------------------------------------------------------------
async function runArm({ name, pool, start, proposer, baseSeed, screen, shouldStop }) {
  let cur = cloneWeights(start);
  let gen = 0;
  let accepts = 0;
  const moves = [];
  const t0 = Date.now();
  if (screen) {
    accepts = 1;
    moves.push({ gen: 0, label: `hypothesis ${screen.label}`, key: 'hypothesis', train: screen.train, confirm: screen.confirm, weights: cur });
    log(`${name}: starts from ${screen.label} (${fmt(screen.confirm)} on confirm)`);
  }
  while (!shouldStop()) {
    gen++;
    const seedA = baseSeed + gen * 31;
    const seedB = seedA + CONFIRM_OFFSET;
    const cands = proposer.propose(cur);
    if (!cands.length || proposer.exhausted()) {
      log(`${name}: converged after ${gen} generations — every live axis has been probed at both signs at the smallest step worth measuring`);
      break;
    }
    let baseT;
    let candT;
    try {
      [baseT, ...candT] = await Promise.all([pool.trace(cur, seedA), ...cands.map((c) => pool.trace(c.weights, seedA))]);
    } catch (e) {
      log(`${name}: batch failed (${e.message}), stopping`);
      break;
    }
    let pick = -1;
    let pickStat = null;
    cands.forEach((c, i) => {
      const st = paired(candT[i], baseT);
      if (st.mean > 0 && st.mean > Z_ACCEPT * st.se && (!pickStat || st.mean > pickStat.mean)) {
        pickStat = st;
        pick = i;
      }
    });
    if (pick < 0) {
      proposer.onFailure(cands);
    } else {
      const c = cands[pick];
      const [b2, c2] = await Promise.all([pool.trace(cur, seedB), pool.trace(c.weights, seedB)]);
      const cf = paired(c2, b2);
      if (cf.mean > 0 && cf.mean > Z_CONFIRM * cf.se) {
        cur = cloneWeights(c.weights);
        accepts++;
        proposer.onAccept(c);
        moves.push({ gen, label: c.label, key: c.key, train: pickStat, confirm: cf, weights: cur });
        fs.appendFileSync(EVENTS, JSON.stringify({ arm: name, gen, label: c.label, train: pickStat, confirm: cf, weights: cur }) + '\n', 'utf8');
        log(`${name}: gen ${gen} accepted ${c.label} train ${fmt(pickStat)} confirm ${fmt(cf)} (accepts ${accepts}, ${((Date.now() - t0) / 1000 / gen).toFixed(0)}s/gen)`);
      } else {
        proposer.onFailure([c]);
        if (gen % 20 === 0) log(`${name}: gen ${gen} rejected ${c.label} at confirm ${fmt(cf)}`);
      }
    }
    if (gen % 15 === 0) {
      saveArm({ name, cur, gen, accepts, moves });
      log(`${name}: gen ${gen}, ${accepts} accepts so far, ${((Date.now() - t0) / 1000).toFixed(0)}s elapsed`);
    }
  }
  saveArm({ name, cur, gen, accepts, moves });
  return { name, cur, gen, accepts, moves, proposer };
}

// Both arms write here so state.json always holds the pair, whichever one moved last. If the box
// sleeps or the run is killed, this is the file the next morning reads.
const stateArms = {};
function saveArm(a) {
  stateArms[a.name] = a;
  writeState();
}

function writeState() {
  const obj = {
    startedAt: startedAt.toISOString(),
    hardEnd: new Date(HARD_END).toISOString(),
    now: new Date().toISOString(),
    cores: CORES,
    matches: MATCHES,
    families: FAM,
    iterations: ITER,
    lambda: LAMBDA,
    layoutsTouchedBySearch: usedSeeds.size,
    arms: Object.values(stateArms).map((a) => ({ name: a.name, gen: a.gen, accepts: a.accepts, weights: a.cur, moves: a.moves })),
  };
  fs.writeFileSync(STATE, JSON.stringify(obj, null, 2), 'utf8');
  // progress.md exists so the run can be read at any moment, including the morning after a killed one.
  const md = `# Night run in progress (state as of ${obj.now})

${MATCHES} MATCHes per evaluation over ${FAM} seed families, λ=${LAMBDA}, ${CORES} cores. Searching until ${new Date(SEARCH_END).toLocaleTimeString('en-GB')}, gate after that.

${Object.values(stateArms)
  .map(
    (a) => `## ${a.name}: ${a.gen} generations, ${a.accepts} accepted moves

| gen | move | training difference | confirm difference |
| --- | --- | --- | --- |
${(a.moves || []).map((m) => `| ${m.gen} | \`${m.label}\` | ${fmt(m.train)} | ${fmt(m.confirm)} |`).join('\n') || '| - | _nothing accepted yet_ | | |'}
`,
  )
  .join('\n')}
Full report with the holdout gate is written at the end to \`report.md\`.
`;
  fs.writeFileSync(PROGRESS, md, 'utf8');
}

// ---------------------------------------------------------------------------
// the gate: seed families the search never saw
// ---------------------------------------------------------------------------
async function gate(pool, cand, label) {
  const shipped = cloneWeights(DEFAULT_WEIGHTS);
  const tBase = freshBase('trace', GATE_MATCHES, 4, 700_001);
  const gBase = freshBase('greedy', GATE_MATCHES, 1, 5_000_007);
  const hBase = freshBase('h2h', GATE_MATCHES, 1, 9_000_007);
  const [bt, ct] = await Promise.all([
    pool.trace(shipped, tBase, GATE_MATCHES, 4, false),
    pool.trace(cand, tBase, GATE_MATCHES, 4, false),
  ]);
  const pair = paired(ct, bt);
  const [h, ggC, ggS] = await Promise.all([pool.h2h(cand, shipped, GATE_MATCHES, hBase), pool.vsGreedy(cand, GATE_MATCHES, gBase), pool.vsGreedy(shipped, GATE_MATCHES, gBase)]);
  const winRate = 100 * (h.aWins + 0.5 * h.draws) / h.matches;
  const p = (h.aWins + 0.5 * h.draws) / h.matches;
  const winSe = 100 * Math.sqrt((p * (1 - p)) / h.matches);
  const clearsPair = pair.mean > 2 * pair.se;
  const clearsH2H = winRate > 50 + 2 * winSe;
  const keepsGreedy = ggC.winRate >= ggS.winRate - 0.03;
  const ship = clearsPair && clearsH2H && keepsGreedy;
  log(`gate ${label}: holdout pair ${fmt(pair)} | h2h ${winRate.toFixed(1)}% | vs greedy ${(ggC.winRate * 100).toFixed(1)}% vs shipped ${(ggS.winRate * 100).toFixed(1)}% | ${ship ? 'SHIP-CANDIDATE' : 'no-ship'}`);
  return { label, pair, winRate, winSe, h2h: h, candGreedy: ggC, shippedGreedy: ggS, clearsPair, clearsH2H, keepsGreedy, ship };
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------
function axisTable(a, b) {
  const rows = WEIGHT_KEYS.map((k) => {
    const s = DEFAULT_WEIGHTS[k];
    const f = (v) => (v === undefined ? '-' : Number(v).toFixed(4));
    const markA = a && Math.abs(a[k] - s) > 1e-9 ? '*' : ' ';
    const markB = b && Math.abs(b[k] - s) > 1e-9 ? '*' : ' ';
    return `| \`${k}\` | ${f(s)} | ${f(a && a[k])}${markA} | ${f(b && b[k])}${markB} |`;
  });
  return ['| weight | shipped | arm A | arm B |', '| --- | --- | --- | --- |', ...rows].join('\n');
}

function writeReport({ probe, screen, armA, armB, gates, stopped }) {
  const probeRows = probe
    .map((r) => `| \`${r.key}\` | ${r.spread.toFixed(4)} | ${r.inert ? 'inert' : 'live'} |`)
    .join('\n');
  const A = armA ? armA.cur : null;
  const B = armB ? armB.cur : null;
  const movesOf = (arm) =>
    arm && arm.moves.length
      ? arm.moves
          .map((m) => `| ${m.gen} | \`${m.label}\` | ${fmt(m.train)} | ${fmt(m.confirm)} |`)
          .join('\n')
      : '_none_';
  const gateBlock = (g) =>
    `**${g.label}**\n\n` +
    `- holdout pair (never-searched families, ${g.pair.n} MATCHes): util difference ${fmt(g.pair)} → ${g.clearsPair ? 'clears' : 'does not clear'} 2·se\n` +
    `- head to head vs shipped: ${g.winRate.toFixed(1)}% (se ±${g.winSe.toFixed(1)}) → ${g.clearsH2H ? 'clears' : 'does not clear'} 50+2·se\n` +
    `- vs greedy win rate: candidate ${(g.candGreedy.winRate * 100).toFixed(1)}% (${g.candGreedy.avgAiScore.toFixed(1)} pts) vs shipped ${(g.shippedGreedy.winRate * 100).toFixed(1)}% (${g.shippedGreedy.avgAiScore.toFixed(1)} pts) → ${g.keepsGreedy ? 'not worse' : 'WORSE against greedy'}\n` +
    `- verdict: **${g.ship ? 'SHIP CANDIDATE' : 'keep the shipped weights'}**\n`;

  const md = `# Overnight weight search — ${startedAt.toLocaleString('en-GB')} → ${new Date().toLocaleString('en-GB')}${stopped ? ' (search window closed: deadline or signal)' : ''}

Config: ${CORES} cores, ${MATCHES} MATCHes per evaluation over ${FAM} seed families, λ=${LAMBDA}, accept at ${Z_ACCEPT}·se on the training seeds AND ${Z_CONFIRM}·se on an independent confirm set.
Seed families touched while searching: ${usedSeeds.size} distinct layouts. The gate plays layouts outside that set.

## Phase −1 — axes the sampled play can even reach

Each knob was driven to both ends of its domain on one ${MATCHES} MATCH set. \`inert\` means not one MATCH
finished differently: the search cannot tune that axis on this play, so it was left out of both arms.

| weight | largest per-MATCH change at either end | |
| --- | --- | --- |
${probeRows}

## Phase 0 — named hypotheses (paired, ${MATCHES} MATCHes)

| hypothesis | training difference | confirm difference | verdict |
| --- | --- | --- | --- |
${screen.results.map((r) => `| \`${r.label}\` | ${fmt(r.train)} | ${fmt(r.confirm)} | ${r.verdict} |`).join('\n')}

## Arm A — coordinate pattern search, started from ${screen.best ? screen.best.label : 'the shipped weights'}

Generations ${armA ? armA.gen : '-'}, accepted moves ${armA ? armA.accepts : '-'}.

| gen | move | training | confirm |
| --- | --- | --- | --- |
${movesOf(armA)}

## Arm B — blind random mutation (control), same sample size and cores

Generations ${armB ? armB.gen : '-'}, accepted moves ${armB ? armB.accepts : '-'}.

| gen | move | training | confirm |
| --- | --- | --- | --- |
${movesOf(armB)}

## Where the vectors ended (\`*\` = moved off the shipped value)

${axisTable(A, B)}

## Gate — seed families neither arm ever searched

${gates.map(gateBlock).join('\n')}

## How to read this

Nothing was written to \`web/js/ai.js\`. If a gate says SHIP, the candidate weights are in
\`.tmp/night/state.json\` and the next step is a daytime A/B (\`node scripts/ab.mjs\`) with the shipped
number quoted alongside it before anything goes on the site. If both arms accepted nothing, that is the
answer to the question the night was run to ask: at this sample size this weight vector has no
neighbour that beats it, and more compute on the same objective will not change that.
`;
  fs.writeFileSync(REPORT, md, 'utf8');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  log(`night start: ${CORES} cores, ${MATCHES} MATCHes/eval x ${FAM} families, lambda ${LAMBDA}, ends ${new Date(HARD_END).toLocaleTimeString('en-GB')}`);
  const pool = new Pool(CORES);
  const probeT = Date.now();
  // One calibration evaluation prints the paired noise floor the acceptance test is priced against:
  // an unchanged vector must difference at 0±0, and the wall time says how many generations the night buys.
  const shipped = cloneWeights(DEFAULT_WEIGHTS);
  const jitter = cloneWeights({ ...shipped, mateSeparation: shipped.mateSeparation + 1e-12 });
  const [p1, p2] = await Promise.all([pool.trace(shipped, TRAIN_BASE_A - 3), pool.trace(jitter, TRAIN_BASE_A - 3)]);
  log(`calibration: ${MATCHES} MATCHes took ${((Date.now() - probeT) / 1000).toFixed(0)}s wall on ${CORES} cores; paired difference for an unchanged vector = ${fmt(paired(p1, p2))}`);

  const probe = await probeAxes(pool);
  const live = WEIGHT_KEYS.filter((k) => !probe.find((r) => r.key === k).inert);
  log(`axes live for search: ${live.length}/${WEIGHT_KEYS.length}`);

  const screen = await screenHypotheses(pool);
  let interrupted = false;
  const abort = () => {
    interrupted = true;
    log('signal received: the arms stop at the next generation boundary and the gate still runs');
  };
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  const watch = setInterval(() => {
    if (Date.now() >= SEARCH_END) {
      log('deadline reached: stopping the search');
      interrupted = true;
      clearInterval(watch);
    }
  }, 20_000);
  watch.unref();

  const axes = live;
  if (!axes.length) {
    log('phase -1 found no knob the sampled play reaches: there is nothing for the search to turn');
    writeReport({ probe, screen, armA: null, armB: null, gates: [], stopped: false });
    process.exit(0);
  }
  const stopNow = () => interrupted || Date.now() >= SEARCH_END;
  const armA = runArm({ name: 'A-pattern', pool, start: screen.start, proposer: makePatternProposer(axes), baseSeed: TRAIN_BASE_A, screen: screen.best, shouldStop: stopNow });
  const armB = runArm({ name: 'B-mutation', pool, start: shipped, proposer: makeMutationProposer(TRAIN_BASE_B, axes), baseSeed: TRAIN_BASE_B, shouldStop: stopNow });
  const settled = await Promise.allSettled([armA, armB]);
  clearInterval(watch);
  const arms = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') arms.push(s.value);
    else log(`arm ${i === 0 ? 'A' : 'B'} died: ${s.reason && s.reason.message}`);
  });
  const doneA = arms.find((a) => a.name === 'A-pattern') || null;
  const doneB = arms.find((a) => a.name === 'B-mutation') || null;
  log(`search done: A ${doneA ? `${doneA.gen} gens / ${doneA.accepts} accepts` : 'crashed'}, B ${doneB ? `${doneB.gen} gens / ${doneB.accepts} accepts` : 'crashed'}`);

  const gates = [];
  for (const arm of arms) {
    const moved = WEIGHT_KEYS.some((k) => Math.abs(arm.cur[k] - DEFAULT_WEIGHTS[k]) > 1e-9);
    if (!moved) {
      log(`gate ${arm.name}: vector identical to the shipped one, nothing to gate`);
      continue;
    }
    gates.push(await gate(pool, arm.cur, arm.name));
  }
  writeReport({ probe, screen, armA: doneA, armB: doneB, gates, stopped: interrupted });
  log(`report written to ${REPORT}`);
  process.exit(0);
}

main().catch((e) => {
  log(`fatal: ${e && e.stack}`);
  writeState();
  process.exit(1);
});
