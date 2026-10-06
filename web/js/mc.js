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
    scoreHist: new Array(13).fill(0), // buckets of 50 points
    deltaHist: new Array(11).fill(0), // -250..+250 in 50-point buckets
    autoWinnerIsAi: 0,
  };
  let recorded = null;
  let plan = null;

  for (let i = 0; i < matches; i++) {
    const sc = { ...base, seed: (seed + i * 7919) >>> 0 };
    const red = makeAlliance(profilesRed, 'red');
    const blue = makeAlliance(profilesBlue, 'blue');
    const alliances = { red, blue };
    const aiSideThis = mode === 'aiVsAi' ? 'red' : aiSide;
    let redPolicy;
    let bluePolicy;
    if (mode === 'aiVsAi') {
      redPolicy = buildMatchPolicies({ side: 'red', profiles: alliances.red.robots, oppProfiles: alliances.blue.robots, weights, scenario: sc, iterations });
      bluePolicy = buildMatchPolicies({ side: 'blue', profiles: alliances.blue.robots, oppProfiles: alliances.red.robots, weights: weightsB || weights, scenario: sc, iterations });
    } else if (aiSideThis === 'red') {
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
      const aiPol = mode === 'aiVsAi' ? redPolicy : aiSideThis === 'red' ? redPolicy : bluePolicy;
      try {
        plan = { side: mode === 'aiVsAi' ? 'red' : aiSideThis, ...aiPol.planSnapshot(), stats: aiPol.stats() };
      } catch (e) {
        plan = null;
      }
    }

    const aSide = mode === 'aiVsAi' ? 'red' : aiSide;
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
    if (res.autoWinner === aSide) agg.autoWinnerIsAi += 1;
    if (onProgress && (i % 10 === 0 || i === matches - 1)) onProgress({ done: i + 1, total: matches });
  }

  const n = agg.matches;
  const pct = (v) => v / n;
  const mean = (v) => v / n;
  return {
    ...agg,
    winRate: (agg.wins + 0.5 * agg.ties) / n,
    decisiveWinRate: agg.wins / n,
    avgAiScore: mean(agg.aiTotal),
    avgOppScore: mean(agg.oppTotal),
    avgRedScore: mean(agg.redTotal),
    avgBlueScore: mean(agg.blueTotal),
    avgFuel: mean(agg.aiFuel),
    avgTower: mean(agg.aiTower),
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
