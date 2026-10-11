// What does the AI actually perceive? A win rate cannot answer that, so this reads the recorded
// timeline of the same MATCHes and prints four separate deficits, each in the units a driver would
// notice. Nothing here is a score.
//
//   TIME      tail%      live-window frames in the last TAIL seconds with the ROBOT still empty and
//                        still on a COLLECT trip: a round trip that cannot finish. Locked at close is
//                        the FUEL in the hoppers the instant the window shut, which cannot score for
//                        the next 25 s.
//   ADAPT     perFault   distance travelled per point scored before against after the engine's own
//                        fault event (faultsEnabled): a driver who feels the ROBOT degrade shortens
//                        their trips, and a policy that never reads rb.health cannot. Also the frames
//                        a DISABLED ROBOT is still flying a moving role on.
//   SPACE     nose>60    the angle between where the square car points and where it is actually going.
//                        The engine limits turn rate, so every wide frame is the car fighting its own
//                        kinematics. aim>20 is the same number at a SCORE frame against the HUB.
//   TEAM      laneEmpty  at the instant the HUB reopens, how many of the three shooting stations are
//                        unoccupied while the ALLIANCE is holding FUEL somewhere else.
//
//   node scripts/cap.mjs
//   MATCHES=12 SEED=90001 OPP=greedy TAIL=5 node scripts/cap.mjs
import { runOneOpponentMatch } from '../web/js/league.js';
import { DEFAULT_WEIGHTS, cloneWeights } from '../web/js/ai.js';
import { GEO, INTENT } from '../web/js/engine.js';

const MATCHES = Number(process.env.MATCHES || 8);
const SEED = Number(process.env.SEED || 90001);
const OPP = process.env.OPP || 'greedy';
const TAIL = Number(process.env.TAIL || 5);
const COLLECTING = new Set([INTENT.COLLECT, INTENT.PUSH]);
const LANE_IN = 60;

// Signed angle difference folded to [0,180] degrees.
function degBetween(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs((d * 180) / Math.PI);
}

function blank() {
  return {
    live: 0, tailFrames: 0, closes: 0, locked: 0,
    noseSum: 0, noseN: 0, noseWide: 0, aimSum: 0, aimN: 0, aimWide: 0,
    dBefore: 0, fBefore: 0, pBefore: 0, dAfter: 0, fAfter: 0, pAfter: 0, faultRobots: 0,
    disabledRoleFrames: 0,
    opens: 0, laneHolders: 0, carryAtOpen: 0, carryOffLane: 0, carryOffLaneSum: 0, carryOffLaneN: 0, openWithLoad: 0,
  };
}
const acc = { ai: blank(), opp: blank() };

for (let m = 0; m < MATCHES; m++) {
  const { res, aiSide } = runOneOpponentMatch({
    kind: OPP,
    weights: cloneWeights(DEFAULT_WEIGHTS),
    seed: SEED + m * 977,
    iterations: 200,
    aiSide: m % 2 ? 'blue' : 'red',
    record: true,
  });
  const tl = res.timeline || [];
  const faults = new Map();
  for (const e of res.events || []) {
    if (e.kind !== 'fault') continue;
    const robot = e.data && e.data.robot;
    if (robot !== undefined && !faults.has(robot)) faults.set(robot, e.t);
  }

  // One backward pass per side gives "seconds until this window closes" for every frame index.
  const closeIn = { red: new Array(tl.length), blue: new Array(tl.length) };
  for (const side of ['red', 'blue']) {
    let next = Infinity;
    for (let i = tl.length - 1; i >= 0; i--) {
      if (!tl[i].hub[side]) next = tl[i].t;
      closeIn[side][i] = next;
    }
  }

  for (let i = 1; i < tl.length; i++) {
    const f = tl[i];
    const p = tl[i - 1];
    for (const side of ['red', 'blue']) {
      const k = side === aiSide ? 'ai' : 'opp';
      const a = acc[k];
      const live = !!f.hub[side];
      const was = !!p.hub[side];
      const mine = f.r.filter((r) => r.a === side);
      if (live) a.live += 1;

      for (const r of mine) {
        const prev = p.r.find((q) => q.i === r.i);
        if (!prev) continue;
        const moved = Math.hypot(r.x - prev.x, r.y - prev.y);
        const gained = Math.max(0, f.s[side].total - p.s[side].total);

        if (live) {
          if (closeIn[side][i] - f.t <= TAIL && COLLECTING.has(r.m) && r.c === 0) a.tailFrames += 1;
          if (moved > 0.5 && !r.d) {
            const e = degBetween(Math.atan2(r.y - prev.y, r.x - prev.x), r.h);
            a.noseSum += e; a.noseN += 1; if (e > 60) a.noseWide += 1;
          }
          if (r.m === INTENT.SCORE) {
            const g = GEO[side];
            const e = degBetween(Math.atan2(g.hub.y - r.y, g.hub.x - r.x), r.h);
            a.aimSum += e; a.aimN += 1; if (e > 20) a.aimWide += 1;
          }
        }
        if (was && !live) { a.closes += 1; a.locked += r.c; }
        if (r.d && (r.m === INTENT.DEFEND || COLLECTING.has(r.m))) a.disabledRoleFrames += 1;

        const ft = faults.get(r.i);
        if (ft !== undefined) {
          if (f.t < ft) { a.dBefore += moved; a.fBefore += 1; a.pBefore += gained; }
          else { a.dAfter += moved; a.fAfter += 1; a.pAfter += gained; }
        }
      }

      if (!was && live) {
        a.opens += 1;
        const st = GEO[side].shootStations;
        // The question is not "is the lane empty" — an empty-handed ROBOT has no reason to be on its
        // lane. It is "is a ROBOT HOLDING FUEL not on its lane", because that load cannot score on the
        // tick the window opens, which is the whole payoff the dark window was spent buying.
        for (let s = 0; s < st.length; s++) {
          const holder = mine[s];
          if (!holder) continue;
          a.laneHolders += 1;
          if (holder.c > 0) {
            a.carryAtOpen += holder.c;
            const off = Math.hypot(holder.x - st[s].x, holder.y - st[s].y);
            if (off > LANE_IN) {
              a.carryOffLane += holder.c;
              a.carryOffLaneSum += off;
              a.carryOffLaneN += 1;
            }
          }
        }
        if (mine.reduce((x, r) => x + r.c, 0) > 0) a.openWithLoad += 1;
      }
    }
  }
  for (const side of ['red', 'blue']) {
    const k = side === aiSide ? 'ai' : 'opp';
    acc[k].faultRobots += countFaulted(tl, faults, side);
  }
  console.log(`match ${m} (AI ${aiSide}): AI ${res.final[aiSide].total.toFixed(0)} vs ${OPP} ${res.final[aiSide === 'red' ? 'blue' : 'red'].total.toFixed(0)} · ${faults.size} ROBOTs faulted`);
}

// A fault lands on one ROBOT of one alliance; count the ones this side actually lost, so the
// pre/post rates can be read as "per faulted ROBOT" rather than per frame.
function countFaulted(tl, faults, side) {
  if (!tl.length) return 0;
  let n = 0;
  for (const idx of faults.keys()) {
    if (tl[1].r.some((r) => r.i === idx && r.a === side)) n += 1;
  }
  return n;
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '—');
// Inches of driving bought per 100 points, either side of the fault: the honest unit for "is this
// ROBOT still going after the same return on the same trip".
const inPer100 = (d, p) => (p > 0 ? (d / p) * 100 : null);
console.log(`\n${MATCHES} MATCHes vs ${OPP}, seed ${SEED}, tail window ${TAIL} s. Per ROBOT-frame unless stated.`);
console.log('side  TIME tail%  locked/window     ADAPT in/100pt before→after fault  disabled-role frames');
for (const k of ['ai', 'opp']) {
  const a = acc[k];
  const b = inPer100(a.dBefore, a.pBefore);
  const after = inPer100(a.dAfter, a.pAfter);
  console.log(
    `${k.padEnd(5)} ${pct(a.tailFrames, a.live).padStart(6)}%   ${(a.closes ? a.locked / a.closes : 0).toFixed(2)}` +
      `   ${(b === null || after === null ? '—' : `${b.toFixed(0)} → ${after.toFixed(0)} (${a.faultRobots ? ((after / b) * 100 - 100).toFixed(0) : '—'}%)`).padStart(18)}` +
      `   ${a.disabledRoleFrames}`,
  );
}
console.log('side  SPACE nose mean° (>60°)      aim° at SCORE frames (>20°)');
for (const k of ['ai', 'opp']) {
  const a = acc[k];
  const nose = a.noseN ? `${(a.noseSum / a.noseN).toFixed(0)}° (${pct(a.noseWide, a.noseN)}% over 60°)` : '—';
  const aim = a.aimN ? `${(a.aimSum / a.aimN).toFixed(0)}° (${pct(a.aimWide, a.aimN)}% over 20°, ${a.aimN} frames)` : '—';
  console.log(`${k.padEnd(5)} ${nose.padStart(24)}   ${aim}`);
}
console.log('side  TEAM FUEL held by a ROBOT off its own lane at reopen, of all FUEL held');
for (const k of ['ai', 'opp']) {
  const a = acc[k];
  console.log(
    `${k.padEnd(5)} ${pct(a.carryOffLane, a.carryAtOpen)}% of ${a.carryAtOpen} FUEL` +
      `   ${(a.carryOffLaneN ? a.carryOffLaneSum / a.carryOffLaneN : 0).toFixed(0)} in out, over ${a.opens} reopens`,
  );
}
