// Dark-window probe. Answers one question: while an ALLIANCE's own HUB is INACTIVE (Table 6-3), what
// do its ROBOTs actually do, and do any of them still launch FUEL at a HUB that scores 0?
//
// The micro policy has an explicit `!hubActive` ladder that never returns SCORE, so a launch here
// would mean the gate is bypassed somewhere else — the macro plan, the engine's own intent handling,
// or a stale observation. This prints the frame mix and the launch count separately per seat so the
// two can be told apart.
//
// Usage: node scripts/dark.mjs          MATCHES=12 OPP=greedy node scripts/dark.mjs

import { runOneOpponentMatch } from '../web/js/league.js';
import { DEFAULT_WEIGHTS, cloneWeights } from '../web/js/ai.js';
import { GEO } from '../web/js/engine.js';

const MATCHES = Number(process.env.MATCHES || 8);
const OPP = process.env.OPP || 'greedy';
const ITER = Number(process.env.ITER || 200);
const SEED = Number(process.env.SEED || 90001);
// W=defenseEfficacy:0.1 moves one shipped weight and leaves the rest alone, so the intent mix can be
// read as the consequence of that number rather than of a different build. Same convention as ab.mjs.
const weights = cloneWeights(DEFAULT_WEIGHTS);
for (const part of (process.env.W || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const [key, val] = part.split(':');
  const k0 = key && key.trim();
  if (!k0 || !(k0 in DEFAULT_WEIGHTS)) {
    console.log(`  unknown weight "${k0}" in W (have: ${Object.keys(DEFAULT_WEIGHTS).join(', ')})`);
    continue;
  }
  weights[k0] = Number(val);
  console.log(`  override ${k0} = ${val}`);
}

const blank = () => ({ frames: 0, mix: new Map(), launches: 0, passes: 0, near: 0 });
// Keyed by who is DRIVING, not by ALLIANCE colour: the AI plays red on every MATCH below, so `ai` is
// the policy under test and `opp` is the hand-written baseline it is being compared against. Pooling
// by colour instead would average the two together and hide whichever one is at fault.
const seat = { ai: blank(), opp: blank() };

const aiSide = 'red';
const oppSide = 'blue';

for (let m = 0; m < MATCHES; m++) {
  const { res } = runOneOpponentMatch({
    kind: OPP,
    weights: cloneWeights(weights),
    seed: SEED + m * 977,
    iterations: ITER,
    aiSide,
    record: true,
  });
  const live = new Set();
  for (const f of res.timeline || []) {
    const hub = f.hub || {};
    // The in-flight record carries the shooter's ROBOT index, and the ROBOT frames carry that
    // index's ALLIANCE, so the two together say who fired the ball that just left a hopper.
    const ownerOf = new Map();
    for (const r of f.r) ownerOf.set(r.i, r.a);
    const inflightNow = new Set();
    for (const b of f.fuel) {
      if (b[3] === 4) inflightNow.add(b[0]);
    }
    for (const r of f.r) {
      const s = seat[r.a === aiSide ? 'ai' : 'opp'];
      if (hub[r.a]) continue; // our own HUB is live: not a dark window
      s.frames += 1;
      s.mix.set(r.m, (s.mix.get(r.m) || 0) + 1);
      // Parked on the HUB face is what reads as "still going to score" in a replay.
      const hubPt = GEO[r.a].hub;
      if (Math.hypot(r.x - hubPt.x, r.y - hubPt.y) < 90) s.near += 1;
    }
    // A launch is an in-flight ball id that was not in flight on the previous frame. `fhub` says where
    // it is bound: 1 the red HUB, 2 the blue HUB, 3 a PASS aim point. Only the first two are shots,
    // and a PASS during a dark window is a good play rather than a wasted one, so it is tallied apart.
    for (const id of inflightNow) {
      if (live.has(id)) continue;
      const ball = f.fuel.find((b) => b[0] === id && b[3] === 4);
      if (!ball) continue;
      const owner = ownerOf.get(ball[6]);
      if (!owner || hub[owner] !== false) continue;
      const s = seat[owner === aiSide ? 'ai' : 'opp'];
      if (ball[4] === (owner === 'red' ? 1 : 2)) s.launches += 1;
      else s.passes += 1;
    }
    live.clear();
    for (const id of inflightNow) live.add(id);
  }
}

for (const k of ['ai', 'opp']) {
  const s = seat[k];
  const total = s.frames || 1;
  const seen = [...s.mix.entries()].sort((p, q) => q[1] - p[1]);
  const parts = seen.map(([mode, v]) => `${mode} ${((100 * v) / total).toFixed(1)}%`);
  const label = k === 'ai' ? `the AI (${aiSide})` : `the ${OPP} baseline (${oppSide})`;
  console.log(`\n${label}: ${s.frames} dark-window ROBOT-frames over ${MATCHES} MATCHes`);
  console.log(`  mix: ${parts.join(' · ')}`);
  console.log(`  FUEL launched at a dead HUB: ${s.launches}   (PASSes thrown in the same window: ${s.passes})`);
  console.log(`  frames inside 90 in of its own HUB: ${s.near} (${((100 * s.near) / total).toFixed(1)}%)`);
}
