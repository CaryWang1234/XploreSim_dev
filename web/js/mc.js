// Monte-Carlo MATCH prediction. Runs whole MATCHES through the real engine (not the analytic
// model) so the reported win probability, score spread and Ranking-Point probabilities come from
// the same code that produces the replay.

import { POINTS } from './rules.js';
import { defaultScenario, makeAlliance } from './model.js';
import { simulateMatch } from './engine.js';
import { createAI } from './policy.js';
import { makeBaseline, capOf } from './league.js';

function buildMatchPolicies({ side, profiles, oppProfiles, weights, scenario, iterations }) {
  return createAI({
    side,
    weights,
    caps: profiles.map(capOf),
    oppProfiles,
    rngSeed: (scenario.seed >>> 0) + (side === 'red' ? 11 : 29),
    iterations,
    objective: scenario.objective,
    event: scenario.event,
    towerL1TeleopAllowed: scenario.towerL1TeleopAllowed,
  });
}

// One definition of the batch's seed family, because the page replays a flagged MATCH by re-running the seed
// that MATCH was measured on. A second copy of this arithmetic elsewhere is a different set of matches wearing
// the same label.
export const MATCH_STRIDE = 7919;
export const matchSeed = (seed, i) => (seed + i * MATCH_STRIDE) >>> 0;

// Which match sits at each end of a distribution, not just what value is there: a batch that says "the AI's best
// was 712" without a match number describes a MATCH nobody can go and look at. First index wins a tie.
export function extremes(values) {
  let hi = 0;
  let lo = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[hi]) hi = i;
    if (values[i] < values[lo]) lo = i;
  }
  return { best: values[hi], bestAt: hi, worst: values[lo], worstAt: lo };
}

export function monteCarlo(opts) {
  const {
    profilesRed,
    profilesBlue,
    weights = null,
    weightsB = null,
    mode = 'vsBaseline', // 'vsBaseline' | 'aiVsAi'
    opponentKind = 'greedy',
    aiSide = 'red',
    matches = 120,
    iterations = 200,
    seed = 20260110,
    scenarioOverride = {},
    recordFirst = true,
    onProgress = null,
  } = opts;

  for (const [name, value] of Object.entries({ matches, iterations })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  }
  if (aiSide !== 'red' && aiSide !== 'blue') throw new RangeError('aiSide must be red or blue');

  const base = { ...defaultScenario(), ...scenarioOverride, seed };
  const agg = {
    matches: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    redTotal: 0,
    blueTotal: 0,
    aiTotal: 0,
    oppTotal: 0,
    aiFuel: 0,
    aiTower: 0,
    rp: { energized: 0, supercharged: 0, traversal: 0, win: 0, total: 0 },
    // Per-MATCH detail a planner actually argues about: the margin, what AUTO produced, the foul
    // exchange, and how much of the match the ALLIANCE spent functionally impaired by a contact
    // (§7.4.4 G415/G416/G417, see the contact switch). `foulsWon` is what this ALLIANCE was credited
    // from the opponent's fouls; `foulsGiven` is what it handed over.
    foulsWon: 0,
    foulsGiven: 0,
    aiAutoFuel: 0,
    impairedSec: 0,
    contactFouls: 0,
    // A count and a share answer different questions — "how often does it happen" and "how bad is a
    // match that has one" — and a batch with 1.3 fouls per match must not render as "130% of matches".
    contactMatches: 0,
    marginTotal: 0,
    bestScore: -Infinity,
    worstScore: Infinity,
    bestMargin: -Infinity,
    scoreHist: new Array(13).fill(0), // buckets of 50 points
    deltaHist: new Array(11).fill(0), // -250..+250 in 50-point buckets
    autoWinnerIsAi: 0,
  };
  let recorded = null;
  let plan = null;
  // One row per MATCH: what it scored and which seed scored it, so the page can name the MATCH at the end of a
  // distribution and replay it. The frames are not kept — a thousand of them would be the bulk of the page's
  // memory, and every one is reproducible from the seed in this row.
  const rows = [];
  // Fouls are assessed against a ROBOT, not against a wall colour, so a batch has to say which machine
  // is conceding them. Keyed by alliance and slot so the same seat's ROBOT is the same row every MATCH.
  const byRobot = new Map();

  for (let i = 0; i < matches; i++) {
    const sc = { ...base, seed: matchSeed(seed, i) };
    const red = makeAlliance(profilesRed, 'red');
    const blue = makeAlliance(profilesBlue, 'blue');
    const alliances = { red, blue };
    let redPolicy;
    let bluePolicy;
    if (mode === 'aiVsAi') {
      redPolicy = buildMatchPolicies({ side: 'red', profiles: alliances.red.robots, oppProfiles: alliances.blue.robots, weights, scenario: sc, iterations });
      bluePolicy = buildMatchPolicies({ side: 'blue', profiles: alliances.blue.robots, oppProfiles: alliances.red.robots, weights: weightsB || weights, scenario: sc, iterations });
    } else if (aiSide === 'red') {
      redPolicy = buildMatchPolicies({ side: 'red', profiles: alliances.red.robots, oppProfiles: alliances.blue.robots, weights, scenario: sc, iterations });
      bluePolicy = makeBaseline(opponentKind, 'blue', sc.seed);
    } else {
      redPolicy = makeBaseline(opponentKind, 'red', sc.seed);
      bluePolicy = buildMatchPolicies({ side: 'blue', profiles: alliances.blue.robots, oppProfiles: alliances.red.robots, weights, scenario: sc, iterations });
    }
    const wantRecord = recordFirst && i === 0;
    const res = simulateMatch({ redAlliance: red, blueAlliance: blue, redPolicy, bluePolicy, scenario: sc, record: wantRecord });
    if (wantRecord) {
      recorded = res;
      // In aiVsAi both seats search, so the plan is read from whichever seat the planner picked — the
      // Tactics panel labels everything with that seat and would otherwise be describing the other one.
      const aiPol = aiSide === 'red' ? redPolicy : bluePolicy;
      try {
        plan = { side: aiSide, ...aiPol.planSnapshot(), stats: aiPol.stats() };
      } catch (e) {
        plan = null;
      }
    }

    const aSide = aiSide;
    const oSide = aSide === 'red' ? 'blue' : 'red';
    const a = res.final[aSide];
    const o = res.final[oSide];
    agg.matches += 1;
    agg.redTotal += res.final.red.total;
    agg.blueTotal += res.final.blue.total;
    agg.aiTotal += a.total;
    agg.oppTotal += o.total;
    agg.aiFuel += a.fuel;
    agg.aiTower += a.towerTotal;
    if (a.total > o.total) agg.wins += 1;
    else if (a.total < o.total) agg.losses += 1;
    else agg.ties += 1;
    agg.rp.energized += a.rp.energized;
    agg.rp.supercharged += a.rp.supercharged;
    agg.rp.traversal += a.rp.traversal;
    agg.rp.win += a.rp.result === 3 ? 1 : 0;
    agg.rp.total += a.rp.total;
    agg.scoreHist[Math.min(12, Math.floor(a.total / 50))] += 1;
    const delta = a.total - o.total;
    agg.deltaHist[Math.min(10, Math.max(0, Math.floor((delta + 250) / 50)))] += 1;
    agg.marginTotal += delta;
    rows.push({ n: i + 1, seed: sc.seed, ai: a.total, opp: o.total, margin: delta, foulsGiven: o.foulPoints });
    agg.foulsWon += a.foulPoints;
    agg.foulsGiven += o.foulPoints;
    agg.aiAutoFuel += (res.autoFuel && res.autoFuel[aSide]) || 0;
    agg.impairedSec += res.robotStats
      .filter((x) => x.alliance === aSide)
      .reduce((s2, x) => s2 + (x.impairedSec || 0), 0);
    const contactThis = res.events.filter((e) => e.kind === 'foul' && /^G41[567]/.test(String(e.reason))).length;
    agg.contactFouls += contactThis;
    if (contactThis > 0) agg.contactMatches += 1;
    for (const x of res.robotStats) {
      const k = `${x.alliance}:${x.slot}`;
      const row = byRobot.get(k) || {
        alliance: x.alliance,
        slot: x.slot,
        team: x.team,
        name: x.name,
        fouls: 0,
        points: 0,
        impairedSec: 0,
        codes: new Map(),
      };
      row.fouls += x.fouls || 0;
      row.points += x.foulPointsGiven || 0;
      row.impairedSec += x.impairedSec || 0;
      byRobot.set(k, row);
    }
    // The clause, not just the count: a batch where one ROBOT's fouls are all G408 says "move its pickup
    // spots off the HUB outlet", and one where they are all G418 says "stop pinning".
    for (const e of res.events) {
      if (e.kind !== 'foul' || e.robot === null || e.robot === undefined) continue;
      const st = res.robotStats[e.robot];
      const row = st && byRobot.get(`${st.alliance}:${st.slot}`);
      if (!row) continue;
      const code = String(e.reason).split(' ')[0];
      row.codes.set(code, (row.codes.get(code) || 0) + 1);
    }
    if (a.total > agg.bestScore) agg.bestScore = a.total;
    if (a.total < agg.worstScore) agg.worstScore = a.total;
    if (delta > agg.bestMargin) agg.bestMargin = delta;
    if (res.autoWinner === aSide) agg.autoWinnerIsAi += 1;
    if (onProgress && (i % 10 === 0 || i === matches - 1)) onProgress({ done: i + 1, total: matches });
  }

  const n = agg.matches;
  const pct = (v) => v / n;
  const mean = (v) => v / n;
  const eAi = extremes(rows.map((r) => r.ai));
  const eOpp = extremes(rows.map((r) => r.opp));
  const eMargin = extremes(rows.map((r) => r.margin));
  const eTotal = extremes(rows.map((r) => r.ai + r.opp));
  return {
    ...agg,
    rows,
    bestTotal: eTotal.best,
    worstTotal: eTotal.worst,
    // Which MATCH each extreme came out of. The page labels these rows and replays them by seed, so an index
    // here is the difference between a distribution and a distribution nobody can look into.
    at: {
      bestAi: eAi.bestAt,
      worstAi: eAi.worstAt,
      bestOpp: eOpp.bestAt,
      worstOpp: eOpp.worstAt,
      bestMargin: eMargin.bestAt,
      worstMargin: eMargin.worstAt,
      bestTotal: eTotal.bestAt,
      worstTotal: eTotal.worstAt,
    },
    winRate: (agg.wins + 0.5 * agg.ties) / n,
    decisiveWinRate: agg.wins / n,
    avgAiScore: mean(agg.aiTotal),
    avgOppScore: mean(agg.oppTotal),
    avgRedScore: mean(agg.redTotal),
    avgBlueScore: mean(agg.blueTotal),
    avgFuel: mean(agg.aiFuel),
    avgTower: mean(agg.aiTower),
    avgMargin: mean(agg.marginTotal),
    avgAutoFuel: mean(agg.aiAutoFuel),
    avgFoulsWon: mean(agg.foulsWon),
    avgFoulsGiven: mean(agg.foulsGiven),
    avgImpairedSec: mean(agg.impairedSec),
    contactFoulsPerMatch: mean(agg.contactFouls),
    contactMatchShare: pct(agg.contactMatches),
    foulByRobot: [...byRobot.values()]
      .sort((a, b) => b.points - a.points || a.alliance.localeCompare(b.alliance) || a.slot - b.slot)
      .map((v) => ({
        alliance: v.alliance,
        slot: v.slot,
        team: v.team,
        name: v.name,
        fouls: mean(v.fouls),
        points: mean(v.points),
        impairedSec: mean(v.impairedSec),
        codes: Object.fromEntries([...v.codes].map(([k, n]) => [k, mean(n)])),
      })),
    rpProb: {
      energized: pct(agg.rp.energized),
      supercharged: pct(agg.rp.supercharged),
      traversal: pct(agg.rp.traversal),
      win: pct(agg.rp.win),
      expected: pct(agg.rp.total),
    },
    autoWinRate: pct(agg.autoWinnerIsAi),
    thresholds: POINTS.rpThreshold,
    recorded,
    plan,
  };
}
