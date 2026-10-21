// Does the card ladder fire, and what does it cost?
//
// §6.6.1: "YELLOW CARDS are additive, meaning that a second YELLOW CARD is automatically converted to a
// RED CARD", and a RED "results in a team being DISQUALIFIED for the MATCH". The engine has always named
// the card in the foul text; `sc.cardLadder` is what makes it cost the machine. Two questions have to be
// answered in that order, because the repo's own rule is that a trigger nobody has seen fire is dead code
// with a comment attached: (1) does it fire at all on this build, and (2) once it fires, what does the
// disqualified ROBOT's absence move in the score.
//
// Everything is paired on identical seeds, and the mirror is one trio on both ALLIANCES, so the only thing
// that differs between the two columns is whether a card is enforced. Contact fouls have to be on for
// there to be a card at all, and they are themselves off by default — the calibration figures were measured
// without them — so this script is the measurement, not a claim about the shipped build.
//
//   node scripts/cards.mjs            MATCHES=96
//   OPPONENT=ai node scripts/cards.mjs   # the searching seat against greedy, win-rate shift only

import { simulateMatch } from '../web/js/engine.js';
import { monteCarlo } from '../web/js/mc.js';
import { DEFAULT_WEIGHTS } from '../web/js/ai.js';
import { SAMPLES, makeAlliance, defaultScenario } from '../web/js/model.js';
import { greedyPolicy } from '../web/js/league.js';

const MATCHES = Number(process.env.MATCHES || 96);
const trio = [SAMPLES[0], SAMPLES[1], SAMPLES[2]];
const seeds = Array.from({ length: MATCHES }, (_, i) => (90001 + i * 313) >>> 0);

const play = (seed, cardLadder) => {
  const sc = { ...defaultScenario(), seed, contactFouls: true, cardLadder };
  return simulateMatch({
    redAlliance: makeAlliance(trio, 'red'),
    blueAlliance: makeAlliance(trio, 'blue'),
    redPolicy: greedyPolicy('red'),
    bluePolicy: greedyPolicy('blue'),
    scenario: sc,
    record: false,
  });
};

const tally = (arm, cardLadder) => {
  let yellow = 0;
  let red = 0;
  let dq = 0;
  let matchesWithCard = 0;
  let matchesWithDq = 0;
  const scores = [];
  for (const seed of seeds) {
    const res = play(seed, cardLadder);
    const c = res.cards.red;
    const b = res.cards.blue;
    const y = c.yellow + b.yellow;
    const r = c.red + b.red;
    const d = c.dq + b.dq;
    yellow += y;
    red += r;
    dq += d;
    if (y + r) matchesWithCard += 1;
    if (d) matchesWithDq += 1;
    scores.push((res.final.red.total + res.final.blue.total) / 2);
  }
  return { arm, yellow, red, dq, matchesWithCard, matchesWithDq, scores, mean: scores.reduce((a, b2) => a + b2, 0) / scores.length };
};

const off = tally('ladder off', false);
const on = tally('ladder on', true);
const print = (t) =>
  console.log(
    `${t.arm}: mean total per ALLIANCE ${t.mean.toFixed(1)}` +
      (t.dq || t.yellow || t.red
        ? ` · ${t.matchesWithCard}/${MATCHES} MATCHes carded, ${t.matchesWithDq}/${MATCHES} with a DISQUALIFICATION · ${t.yellow} YELLOW, ${t.red} RED (${t.dq} out)`
        : ' · cards are not counted in this arm: the ladder is what counts them'),
  );
print(off);
print(on);

if (on.dq === 0 && on.yellow + on.red === 0) {
  console.error('\nFAIL: the ladder issued nothing at all over ' + MATCHES + ' MATCHes, so it is unreachable code and no number below this line means anything.');
  process.exit(1);
}
if (on.dq === 0) {
  console.log('NOTE: cards were issued but no ROBOT was disqualified — on this build no machine takes two of them in one MATCH, so the ladder is a warning, not an absence.');
}

// Paired difference: the same seeds in both arms, so the layouts cancel and what is left is the rule.
const diff = on.scores.map((v, i) => v - off.scores[i]);
const mean = diff.reduce((a, b) => a + b, 0) / diff.length;
const variance = diff.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, diff.length - 1);
const sem = Math.sqrt(variance / diff.length);
console.log(`\npaired difference in total per ALLIANCE: ${mean.toFixed(1)} ± ${sem.toFixed(1)} points over ${diff.length} MATCHes on identical seeds (${(mean / sem).toFixed(1)} standard errors)`);
console.log(`cards per MATCH: ${(on.yellow / MATCHES).toFixed(2)} YELLOW, ${(on.red / MATCHES).toFixed(2)} RED, against the real 2026 Einstein Finals which the setup note puts at 0-2 fouls a MATCH`);

if (process.env.OPPONENT === 'ai') {
  // The searching seat reacts as well as the machine: with a disqualification on the table, a DEFEND plan
  // costs more than the foul line, so the win rate is the number to read.
  const run = (cardLadder) =>
    monteCarlo({
      profilesRed: trio,
      profilesBlue: trio,
      weights: DEFAULT_WEIGHTS,
      seed: 20260110,
      iterations: 140,
      matches: Math.ceil(MATCHES / 3),
      recordFirst: false,
      mode: 'vsBaseline',
      aiSide: 'red',
      scenarioOverride: { ...defaultScenario(), contactFouls: true, cardLadder },
    });
  const a = run(false);
  const b = run(true);
  console.log(`\nAI seat vs greedy, ladder off: win ${(a.winRate * 100).toFixed(1)}% score ${a.avgAiScore.toFixed(1)} margin ${a.avgMargin.toFixed(1)} · ladder on: win ${(b.winRate * 100).toFixed(1)}% score ${b.avgAiScore.toFixed(1)} margin ${b.avgMargin.toFixed(1)} (n=${a.matches} per arm)`);
}
