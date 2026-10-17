// Who actually takes AUTO, and what taking it costs.
//
// §Table 6-3 makes the ALLIANCE that loses AUTO sit out SHIFT 1 and 3, so the scoreboard answer is not
// obviously "winning is better": the loser plays SHIFT 2 and 4 against a FUEL pool the winner has already
// been eating from. Against greedy the AI wins AUTO rarely, and a MATCH log cannot say whether that is a
// choice or a result — winning AUTO means your AUTO ran well, and a good AUTO is worth more than the two
// shifts it costs you. This prints the split, so the two can at least be read side by side; the
// experiment that separates them is `scripts/seat.mjs`, which pins the outcome and holds AUTO quality
// identical.
//
//   node scripts/autowin.mjs
//   MATCHES=48 SEED=700001 node scripts/autowin.mjs

import { DEFAULT_WEIGHTS, cloneWeights } from '../web/js/ai.js';
import { runOneOpponentMatch } from '../web/js/league.js';

const MATCHES = Number(process.env.MATCHES || 24);
const SEED = Number(process.env.SEED || 90001);
const ITER = Number(process.env.ITER || 200);

let aiWins = 0;
let aiAuto = 0;
let oppAuto = 0;
const wonScore = [];
const lostScore = [];
for (let m = 0; m < MATCHES; m++) {
  const seed = SEED + m * 977;
  const { res, aiSide } = runOneOpponentMatch({ kind: 'greedy', weights: cloneWeights(DEFAULT_WEIGHTS), seed, iterations: ITER });
  const opp = aiSide === 'red' ? 'blue' : 'red';
  aiAuto += res.autoFuel[aiSide];
  oppAuto += res.autoFuel[opp];
  const taken = res.autoWinner === aiSide;
  if (taken) aiWins += 1;
  (taken ? wonScore : lostScore).push(res.final[aiSide].total);
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sem = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1) / a.length);
};

console.log(`AI (red) vs greedy · ${MATCHES} MATCHes · seed family ${SEED} · iterations ${ITER}`);
console.log(
  `  AUTO FUEL   AI ${(aiAuto / MATCHES).toFixed(1)}   greedy ${(oppAuto / MATCHES).toFixed(1)}` +
    `   AI took AUTO in ${aiWins} of ${MATCHES} (${((aiWins / MATCHES) * 100).toFixed(0)}%)`,
);
console.log(
  `  AI score when it WON AUTO   ${mean(wonScore).toFixed(1)} ± ${sem(wonScore).toFixed(1)}  (n=${wonScore.length})` +
    `   when it LOST   ${mean(lostScore).toFixed(1)} ± ${sem(lostScore).toFixed(1)}  (n=${lostScore.length})`,
);
console.log('  (the split is confounded: a good AUTO both wins the period and is worth more than the window it costs)');
