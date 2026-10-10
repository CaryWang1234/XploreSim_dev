// Does the AI know what time it is, and does it play as three ROBOTs or as one ROBOT three times?
//
// A win rate cannot answer either question, and both are visible in the replay rather than in the
// score. This reads the recorded timeline for both sides of the same MATCHes and prints:
//
//   bunch        frames where two allies are inside bumper range (34 in) and neither is climbing.
//                They are shoving each other instead of cycling, and it is a coordination failure:
//                nobody assigned them different ground.
//   samePile     the subset of those where BOTH are collecting, i.e. two ROBOTs driving at one pile.
//   caughtFar    when our HUB goes dark, how far from home the ROBOTs still carrying were. A ROBOT
//                200 in out at that instant has bought a load it cannot score for 25 s.
//   loadedAtOpen how much the ALLIANCE is holding at the instant its HUB comes back. This is the
//                payoff for spending the dark window banking and coming home in time.
//   strandedDark frames spent dark, carrying, and more than 100 in from our own HUB.
//
//   node scripts/team.mjs
//   MATCHES=12 SEED=90001 node scripts/team.mjs
import { runOneOpponentMatch } from '../web/js/league.js';
import { DEFAULT_WEIGHTS, cloneWeights } from '../web/js/ai.js';
import { GEO, INTENT } from '../web/js/engine.js';

const MATCHES = Number(process.env.MATCHES || 6);
const SEED = Number(process.env.SEED || 90001);
const OPP = process.env.OPP || 'greedy';
const BUMPER_IN = 34;
const STRANDED_IN = 100;

const COLLECTING = new Set([INTENT.COLLECT, INTENT.PUSH, INTENT.STOCKPILE]);

function blank() {
  return { frames: 0, bunch: 0, samePile: 0, darkCarry: 0, stranded: 0, caughtFar: 0, caughtN: 0, openCarry: 0, openN: 0 };
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
  let prevHub = null;
  for (const f of tl) {
    for (const side of ['red', 'blue']) {
      const k = side === aiSide ? 'ai' : 'opp';
      const a = acc[k];
      const live = f.hub[side] ? 1 : 0;
      const was = prevHub ? prevHub[side] : null;
      const mine = f.r.filter((r) => r.a === side && !r.d && !(r.k > 0));
      a.frames += 1;

      for (let i = 0; i < mine.length; i++) {
        for (let j = i + 1; j < mine.length; j++) {
          if (Math.hypot(mine[i].x - mine[j].x, mine[i].y - mine[j].y) >= BUMPER_IN) continue;
          a.bunch += 1;
          if (COLLECTING.has(mine[i].m) && COLLECTING.has(mine[j].m)) a.samePile += 1;
        }
      }

      if (!live) {
        for (const r of mine) {
          if (r.c <= 0) continue;
          a.darkCarry += 1;
          if (Math.hypot(r.x - GEO[side].hub.x, r.y - GEO[side].hub.y) > STRANDED_IN) a.stranded += 1;
        }
      }
      // The frame the window closes: how far out were the ROBOTs still holding FUEL?
      if (was === 1 && live === 0) {
        for (const r of mine) {
          if (r.c <= 0) continue;
          a.caughtFar += Math.hypot(r.x - GEO[side].hub.x, r.y - GEO[side].hub.y);
          a.caughtN += 1;
        }
      }
      // The frame it reopens: what is the ALLIANCE holding, ready to score?
      if (was === 0 && live === 1) {
        a.openCarry += mine.reduce((s, r) => s + r.c, 0);
        a.openN += 1;
      }
    }
    prevHub = { red: f.hub.red ? 1 : 0, blue: f.hub.blue ? 1 : 0 };
  }
  console.log(`match ${m} (AI ${aiSide}): AI ${res.final[aiSide].total.toFixed(0)} vs ${OPP} ${res.final[aiSide === 'red' ? 'blue' : 'red'].total.toFixed(0)}`);
}

const pct = (n, d) => (d ? ((100 * n) / d).toFixed(1) : '—');
console.log(`\n${MATCHES} MATCHes vs ${OPP}, seed ${SEED} · bunch counts pairs per frame, the rest are per ROBOT-frame`);
console.log('side  frames  bunch%  samePile%  caughtFar(in)  loadedAtOpen  stranded%ofDarkCarry');
for (const k of ['ai', 'opp']) {
  const a = acc[k];
  console.log(
    `${k.padEnd(5)} ${String(a.frames).padStart(7)} ${pct(a.bunch, a.frames).padStart(6)} ${pct(a.samePile, a.frames).padStart(10)}` +
      ` ${(a.caughtN ? a.caughtFar / a.caughtN : 0).toFixed(0).padStart(14)} ${(a.openN ? a.openCarry / a.openN : 0).toFixed(1).padStart(13)}` +
      ` ${pct(a.stranded, a.darkCarry).padStart(19)}  (${a.caughtN} caught, ${a.openN} opens, ${a.darkCarry} dark-carrying frames)`,
  );
}
