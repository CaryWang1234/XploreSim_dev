// Does the PASS reach (profile `passRangeIn`) actually bound a throw?
//
// Prints, per arm: how many passes were thrown, how far each travelled from the launcher to where it
// came down, and where that is on the FIELD (own ALLIANCE ZONE / own half / opponent half). `cross` is
// the play the reach is there to make possible — a load handed from inside the opponent's ALLIANCE ZONE
// back into our own. The control arm (`eager:4000`) is a reach nobody can exceed, i.e. a pass of any
// length, which is how the engine behaved before the field existed: if the cap does not move the max
// distance, the cap is not doing anything.
//
//   node scripts/range.mjs
//   MATCHES=24 ARMS=off,eager:4000,eager:520,eager:140 node scripts/range.mjs

import { simulateMatch, GEO } from '../web/js/engine.js';
import { defaultScenario, SAMPLES } from '../web/js/model.js';
import { createAI } from '../web/js/policy.js';
import { capOf, makeBaseline, buildAlliances } from '../web/js/league.js';
import { DEFAULT_WEIGHTS, cloneWeights } from '../web/js/ai.js';

const ARMS = (process.env.ARMS || 'off,eager:4000,eager:520,eager:260,eager:140')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => (s.includes(':') ? { mode: s.split(':')[0], range: Number(s.split(':')[1]) } : { mode: s, range: 520 }));
const MATCHES = Number(process.env.MATCHES || 8);
const SEED = Number(process.env.SEED || 90001);
const ITER = Number(process.env.ITER || 120);

const ownZone = (side, x) => x >= GEO[side].allianceZone[0] && x <= GEO[side].allianceZone[1];
const ownHalf = (side, x) => (side === 'red' ? x < GEO.centerLineX : x > GEO.centerLineX);

function runArm(mode, range) {
  // The same trio on both seats, as every mirror here does: a per-seat roster would measure the ROBOTs
  // as well as the reach. The AI drives red; blue flies the hand-written baseline.
  const trio = SAMPLES.slice(0, 3).map((p) => ({ ...p, passMode: mode, passRangeIn: range }));
  const acc = { thrown: 0, dist: [], zone: 0, half: 0, far: 0, cross: 0, score: 0, scores: [] };
  for (let m = 0; m < MATCHES; m++) {
    const seed = SEED + m * 977;
    const sc = { ...defaultScenario(), seed };
    const profiles = trio.map((p) => JSON.parse(JSON.stringify(p)));
    const alliances = buildAlliances(profiles, profiles);
    const red = createAI({
      side: 'red',
      weights: cloneWeights(DEFAULT_WEIGHTS),
      caps: alliances.red.robots.map(capOf),
      oppProfiles: alliances.blue.robots,
      rngSeed: seed * 31 + 7,
      iterations: ITER,
      objective: sc.objective,
      event: sc.event,
      towerL1TeleopAllowed: sc.towerL1TeleopAllowed,
    });
    const blue = makeBaseline('greedy', 'blue', seed * 17 + 3);
    const res = simulateMatch({
      redAlliance: alliances.red,
      blueAlliance: alliances.blue,
      redPolicy: red,
      bluePolicy: blue,
      scenario: sc,
      record: true,
    });
    acc.score += res.final.red.total;
    acc.scores.push(res.final.red.total);

    let prev = new Map(); // FUEL id -> its record on the previous frame
    const flySrc = new Map(); // FUEL id -> where the launcher stood when it left the hopper
    for (const f of res.timeline) {
      const posOf = new Map();
      for (const r of f.r) posOf.set(r.i, { x: r.x, y: r.y, a: r.a });
      const cur = new Map();
      for (const b of f.fuel) cur.set(b[0], b);
      for (const [id, b] of cur) {
        const p = prev.get(id);
        const wasFly = p && p[3] === 4;
        const isFly = b[3] === 4;
        // A PASS in flight is element 3 = 4 with flight target 4 = 3; 6 is the launcher's ROBOT index.
        if (isFly && !wasFly && b[4] === 3) {
          const src = posOf.get(b[6]);
          if (src) {
            acc.thrown += 1;
            flySrc.set(id, src);
          }
        }
        if (wasFly && !isFly && p[4] === 3) {
          const src = flySrc.get(id) || posOf.get(p[6]);
          flySrc.delete(id);
          if (!src) continue;
          acc.dist.push(Math.hypot(b[1] - src.x, b[2] - src.y));
          const oppSide = src.a === 'red' ? 'blue' : 'red';
          if (ownZone(oppSide, src.x) && ownZone(src.a, b[1])) acc.cross += 1;
          if (ownZone(src.a, b[1])) acc.zone += 1;
          else if (ownHalf(src.a, b[1])) acc.half += 1;
          else acc.far += 1;
        }
      }
      prev = cur;
    }
  }
  return acc;
}

const pctl = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(q * a.length))] : NaN);
const fmt = (v) => (Number.isFinite(v) ? v.toFixed(0).padStart(5) : '    -');
// Standard error of the MATCH mean, so a score difference between arms is read against the seed noise
// and not as a finding on its own (the same convention as every other harness here).
const sem = (a) => {
  const n = a.length;
  if (n < 2) return NaN;
  const m = a.reduce((s, v) => s + v, 0) / n;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (n - 1) / n);
};

console.log(`pass reach sweep · ${MATCHES} MATCHes · seed family ${SEED} · 254/1678/1690 on both seats, AI (red) vs greedy`);
console.log('`cross` = thrown from inside the opponent ALLIANCE ZONE and came down inside our own.');
console.log('`maxd` is launcher-to-landing: the cap puts it at the reach plus at most one tick of flight overshoot.');
console.log('            thrown   p50d   p90d   maxd   in-own-zone  own-half  opp-half  cross      red score');
for (const arm of ARMS) {
  const a = runArm(arm.mode, arm.range);
  console.log(
    `${`${arm.mode}:${arm.range}`.padStart(12)}  ${String(a.thrown).padStart(6)}  ${fmt(pctl(a.dist, 0.5))}  ${fmt(pctl(a.dist, 0.9))}  ${fmt(
      a.dist.length ? Math.max(...a.dist) : NaN,
    )}   ${String(a.zone).padStart(8)}  ${String(a.half).padStart(8)}  ${String(a.far).padStart(8)}  ${String(a.cross).padStart(5)}  ${(
      a.score / MATCHES
    ).toFixed(1)} ± ${sem(a.scores).toFixed(1)}`,
  );
}
