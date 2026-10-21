// Which Table 6-5 rungs can still move, and whether the objective weights the right ones.
//
// The BONUS rungs are step functions at fixed bars, so a rung the shipped build clears in every MATCH
// adds the same number to every candidate's utility and selects between nobody. That is how
// `smoothUtility` lost its two FUEL terms: measured here, ENERGIZED and SUPERCHARGED are reached in
// 100.0% of MATCHes on both arms (FUEL p10 529 against bars of 100 and 360, and 240 at the district
// CHAMPIONSHIP column is cleared by the same population), while TRAVERSAL is reached in 3.3% of the
// searching seat's MATCHes and 0.0% of the greedy mirror's, where TOWER sits at a constant 20 against
// a bar of 50.
//
// So this is the guard, in both directions: a LIVE term that measures saturated is dead weight in the
// objective, and a MUTED term that measures below 95% is a signal the objective threw away. Flip a
// flag in `RP_TERMS` without re-running this and it fails, which is the point — the flags are a claim
// about the current calibration, not a permanent property of the game. Re-anchor throughput or import
// a real roster's numbers and the FUEL rungs have to come back, here first.
//
//   node scripts/rp.mjs            MATCHES=48 CORES=1
//   ARMS=greedy node scripts/rp.mjs   # only the cheap arm

import { simulateMatch } from '../web/js/engine.js';
import { monteCarlo } from '../web/js/mc.js';
import { DEFAULT_WEIGHTS } from '../web/js/ai.js';
import { SAMPLES, makeAlliance, defaultScenario } from '../web/js/model.js';
import { rpBars } from '../web/js/rules.js';
import { RP_TERMS, smoothUtility, greedyPolicy } from '../web/js/league.js';

const MATCHES = Number(process.env.MATCHES || 48);
const ITER = Number(process.env.ITERATIONS || 120);
const EVENT = process.env.EVENT === 'districtChamp' ? 'districtChamp' : 'regional';
const BARS = rpBars(EVENT);
const RUNGS = ['energized', 'supercharged', 'traversal'];
const failures = [];

const grade = (fuel, tower) => ({
  energized: fuel >= BARS.energized ? 1 : 0,
  supercharged: fuel >= BARS.supercharged ? 1 : 0,
  traversal: tower >= BARS.traversal ? 1 : 0,
});

const q = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN);

// ---- arm 1: the greedy mirror, every MATCH of both ALLIANCES -------------------------------
// Same trio both sides, so what is measured is the field and the scoring, not a roster gap.
const trio = [SAMPLES[0], SAMPLES[1], SAMPLES[2]];
const greFuel = [];
const greTower = [];
for (let m = 0; m < MATCHES; m++) {
  const sc = { ...defaultScenario(), seed: 90001 + m * 313, event: EVENT };
  const res = simulateMatch({
    redAlliance: makeAlliance(trio, 'red'),
    blueAlliance: makeAlliance(trio, 'blue'),
    redPolicy: greedyPolicy('red'),
    bluePolicy: greedyPolicy('blue'),
    scenario: sc,
    record: false,
  });
  for (const side of ['red', 'blue']) {
    greFuel.push(res.final[side].fuel);
    greTower.push(res.final[side].towerTotal);
    // The engine must grade against the column this MATCH is played at, and the bars it graded with
    // have to travel out with the verdict — the page prints them beside the rate.
    const t = res.final[side].rp.thresholds;
    if (t.energized !== BARS.energized || t.supercharged !== BARS.supercharged || t.traversal !== BARS.traversal || t.event !== BARS.event) {
      failures.push(`greedy MATCH ${m + 1} ${side}: engine graded against ${JSON.stringify(t)}, the ${BARS.event} column is ${JSON.stringify(BARS)}`);
    }
    for (const rung of RUNGS) {
      if (res.final[side].rp[rung] !== grade(res.final[side].fuel, res.final[side].towerTotal)[rung]) {
        failures.push(`greedy MATCH ${m + 1} ${side}: rp.${rung} = ${res.final[side].rp[rung]} but FUEL ${res.final[side].fuel} / TOWER ${res.final[side].towerTotal} against ${BARS[rung]} says ${grade(res.final[side].fuel, res.final[side].towerTotal)[rung]}`);
      }
    }
  }
}

// ---- arm 2: the searching seat against the greedy baseline ----------------------------------
// This is the population the evolution actually sees, so it is the one the flags are about.
const ai = monteCarlo({
  profilesRed: trio,
  profilesBlue: trio,
  weights: DEFAULT_WEIGHTS,
  seed: 20260110,
  iterations: ITER,
  matches: Math.ceil(MATCHES / 2),
  recordFirst: false,
  mode: 'vsBaseline',
  aiSide: 'red',
  scenarioOverride: { ...defaultScenario(), event: EVENT },
});
const aiRate = { energized: ai.rpProb.energized, supercharged: ai.rpProb.supercharged, traversal: ai.rpProb.traversal };
if (ai.thresholds.energized !== BARS.energized) {
  failures.push(`the batch reported thresholds ${JSON.stringify(ai.thresholds)} for a ${BARS.event} event`);
}

// What a rung's term can actually do across a batch: `min(1, value/bar)` over every MATCH, on both
// arms. A spread of 0 means every candidate gets the same number from that term, which is the only
// thing an objective can select on — so the pass/fail is on the spread, and the reach rate is printed
// beside it because the two are different claims (TRAVERSAL's rung is reached in nobody's MATCH while
// its term still separates a climbing alliance from one that does not).
const reach = (pop, bar) => (pop.length ? pop.filter((v) => v >= bar).length / pop.length : 0);
const spread = (pop, bar) => (pop.length ? Math.min(1, Math.max(...pop) / bar) - Math.min(1, Math.min(...pop) / bar) : 0);
const arms = {
  greedy: { fuel: greFuel, tower: greTower },
  searched: { fuel: ai.rows.map((r) => r.fuel), tower: ai.rows.map((r) => r.tower) },
};

console.log(`${EVENT} column: ENERGIZED ≥ ${BARS.energized} · SUPERCHARGED ≥ ${BARS.supercharged} · TRAVERSAL ≥ ${BARS.traversal}`);
console.log(`greedy mirror, ${MATCHES} MATCHes × 2 ALLIANCES: FUEL p10 ${q(greFuel, 0.1)} / median ${q(greFuel, 0.5)} / p90 ${q(greFuel, 0.9)}, TOWER p10 ${q(greTower, 0.1)} / median ${q(greTower, 0.5)} / p90 ${q(greTower, 0.9)}`);
console.log(`searching seat, ${ai.matches} MATCHes: avg FUEL ${ai.avgFuel.toFixed(1)}, avg TOWER ${ai.avgTower.toFixed(1)}`);
console.log('\nrung          bar      reached (greedy / searched)   term Δ (greedy / searched)   objective');
for (const rung of RUNGS) {
  const bar = BARS[rung];
  const per = Object.entries(arms).map(([name, pop]) => {
    const vals = rung === 'traversal' ? pop.tower : pop.fuel;
    return { name, reach: reach(vals, bar), spread: spread(vals, bar), n: vals.length };
  });
  const live = RP_TERMS[rung].live;
  if (live && per.every((p) => p.spread === 0)) {
    failures.push(`${rung} is live in the objective but its term is the same number in every MATCH of both arms (weight ${RP_TERMS[rung].weight}) — a constant selects nobody`);
  }
  if (!live && per.some((p) => p.spread > 0)) {
    failures.push(`${rung} is muted, yet its term moves by ${Math.max(...per.map((p) => p.spread)).toFixed(3)} across ${Math.min(...per.map((p) => p.n))}+ MATCHes — the calibration changed and the objective did not follow`);
  }
  console.log(
    `${rung.padEnd(12)} ≥${String(bar).padEnd(6)} ${(per.map((p) => `${(p.reach * 100).toFixed(1)}%`).join(' / ')).padEnd(24)} ${(per.map((p) => `Δ${p.spread.toFixed(3)}`).join(' / ')).padEnd(24)} ${live ? `live, weight ${RP_TERMS[rung].weight}` : `muted (weight ${RP_TERMS[rung].weight})`}`,
  );
}
console.log(`\nreached on the searching seat, straight from the batch: energized ${(aiRate.energized * 100).toFixed(1)}%, supercharged ${(aiRate.supercharged * 100).toFixed(1)}%, traversal ${(aiRate.traversal * 100).toFixed(1)}%`);

// ---- do the flags actually reach the arithmetic? -------------------------------------------
// Two MATCHes with identical scores, one clearing every bar and one clearing none: the utility gap is
// exactly the sum of the LIVE weights, because the muted rungs must contribute nothing. A flag that is
// read by the wrong branch would show up here, not in a comment.
const fake = (fuel, tower) => ({ final: { red: { total: 600, fuel, towerTotal: tower }, blue: { total: 500, fuel: 0, towerTotal: 0 } } });
const liveWeight = RUNGS.reduce((s, r) => s + (RP_TERMS[r].live ? RP_TERMS[r].weight : 0), 0);
const gap = smoothUtility(fake(9999, 9999), 'red', BARS) - smoothUtility(fake(0, 0), 'red', BARS);
const want = liveWeight * 1; // every live rung goes 0 → ceiling, margins identical in both
console.log(`\nutility gap between clearing every rung and clearing none: ${gap.toFixed(4)} (live weights sum to ${liveWeight.toFixed(4)})`);
if (Math.abs(gap - want) > 1e-9) {
  failures.push(`smoothUtility moved by ${gap.toFixed(4)} across the rungs, but RP_TERMS declares ${want.toFixed(4)} of live weight — the flags and the arithmetic disagree`);
}
// And the DCMP column has to bite where the regional one does not: a FUEL count between the two bars
// must read as ENERGIZED at a regional and not at a district CHAMPIONSHIP.
if (rpBars('regional').energized >= rpBars('districtChamp').energized) {
  failures.push(`the two Table 6-5 columns are not ordered (regional ${rpBars('regional').energized}, DCMP ${rpBars('districtChamp').energized})`);
}
const mid = Math.round((rpBars('regional').energized + rpBars('districtChamp').energized) / 2);
for (const [event, expect] of [['regional', 1], ['districtChamp', 0]]) {
  const b = rpBars(event);
  const got = mid >= b.energized ? 1 : 0;
  if (got !== expect) failures.push(`FUEL ${mid} between the columns graded ENERGIZED=${got} at ${event}, expected ${expect}`);
}
const midGrade = (event) => (mid >= rpBars(event).energized ? 'ENERGIZED' : 'not ENERGIZED');
console.log(`FUEL ${mid}, between the two columns: ${midGrade('regional')} at regional, ${midGrade('districtChamp')} at district CHAMPIONSHIP`);

if (failures.length) {
  console.error(`\nFAIL (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('\nOK: the objective weights exactly the rungs that can still move, and every MATCH is graded against the column its event names.');
