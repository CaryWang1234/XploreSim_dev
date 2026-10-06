// Baselines, match running and evolution. Used headlessly (scripts/bench.mjs) and in the browser
// worker to train the micro-policy weights by self-play, with Elo against named baselines so the
// claim "the AI is strong" is backed by a number rather than an assertion.

import { TIME, POINTS } from './rules.js';
import { GEO, INTENT, simulateMatch } from './engine.js';
import { defaultScenario, makeAlliance, SAMPLES, periodAt } from './model.js';
import { hubActiveTable } from './rules.js';
import { makeContext, evaluateMatch, emptyPlan, withClimb, withRoles, ROLE } from './fastsim.js';
import { DEFAULT_WEIGHTS, WEIGHT_KEYS, cloneWeights } from './ai.js';
import { createAI } from './policy.js';

export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const inZone = (rb, side) => {
  const z = GEO[side].allianceZone;
  return rb.x >= z[0] && rb.x <= z[1];
};

// ---------------------------------------------------------------------------------------------
// Baseline policies. These are the yardsticks: each is a plausible human-authored strategy, so
// beating them means the AI found something a competent team would not have written by hand.
// ---------------------------------------------------------------------------------------------

// 1. random: uniform intent each decision. A floor, not a strategy.
function randomPolicy(side, seed) {
  const rnd = makeRng(seed);
  return {
    reset() {},
    onPeriodStart() {},
    decide(rb, obs) {
      const r = rnd();
      if (r < 0.62) {
        let best = null;
        for (let i = 0; i < obs.fuel.total; i += 7) {
          if (obs.fuel.state[i] === 0) {
            best = { x: obs.fuel.x[i], y: obs.fuel.y[i] };
            break;
          }
        }
        return { mode: INTENT.COLLECT, target: best || GEO[side].shoot };
      }
      if (r < 0.88) return { mode: INTENT.SCORE };
      if (r < 0.94) return { mode: INTENT.DEFEND, targetRobot: obs.robots.find((o) => o.alliance !== side)?.idx || 0 };
      return { mode: INTENT.CLIMB, level: 1 };
    },
  };
}

// 2. shootalways: greedy nearest FUEL, dumps whenever full even if the HUB is inactive, which
//    throws away FUEL that scores zero (Table 6-4) and never defends.
function shootAlwaysPolicy(side) {
  return {
    reset() {},
    onPeriodStart() {},
    decide(rb, obs) {
      if (rb.carrying >= rb.capacity) return { mode: INTENT.SCORE };
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < obs.fuel.total; i += 4) {
        if (obs.fuel.state[i] !== 0) continue;
        const d = (obs.fuel.x[i] - rb.x) ** 2 + (obs.fuel.y[i] - rb.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x: obs.fuel.x[i], y: obs.fuel.y[i] };
        }
      }
      return best ? { mode: INTENT.COLLECT, target: best } : { mode: INTENT.IDLE };
    },
  };
}

// 3. greedy: HUB-window aware (never wastes FUEL), nearest-FUEL cycling, climbs L3 at the end with
//    every ROBOT. This is the "competent human plan" yardstick the AI has to beat.
export function greedyPolicy(side) {
  return {
    reset() {},
    onPeriodStart() {},
    decide(rb, obs) {
      const g = GEO[side];
      const period = obs.period;
      if (period === 'END GAME' && !rb.climb.done && rb.derived.maxClimbLevel >= 1) {
        if (rb.carrying === 0 || obs.t > TIME.matchSec - 14) return { mode: INTENT.CLIMB, level: rb.derived.maxClimbLevel };
      }
      const active = obs.hub[side];
      if (active && rb.carrying > 0 && (inZone(rb, side) || rb.carrying >= rb.capacity)) return { mode: INTENT.SCORE };
      if (!active && rb.carrying >= rb.capacity) return { mode: INTENT.STOCKPILE, target: g.shoot };
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < obs.fuel.total; i += 2) {
        if (obs.fuel.state[i] !== 0) continue;
        const d = (obs.fuel.x[i] - rb.x) ** 2 + (obs.fuel.y[i] - rb.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x: obs.fuel.x[i], y: obs.fuel.y[i] };
        }
      }
      return best ? { mode: INTENT.COLLECT, target: best } : { mode: INTENT.STOCKPILE, target: g.shoot };
    },
  };
}

export const BASELINE_KINDS = ['random', 'shootalways', 'greedy'];

export function makeBaseline(kind, side, seed = 1) {
  if (kind === 'random') return randomPolicy(side, seed);
  if (kind === 'shootalways') return shootAlwaysPolicy(side);
  return greedyPolicy(side);
}

// ---------------------------------------------------------------------------------------------
// Match orchestration
// ---------------------------------------------------------------------------------------------
export function buildAlliances(profilesRed, profilesBlue) {
  return { red: makeAlliance(profilesRed, 'red'), blue: makeAlliance(profilesBlue, 'blue') };
}

export function runOneOpponentMatch({ kind, weights, seed, record = false, scenarioOverride = {}, aiSide = 'red', iterations = 200 }) {
  const sc = { ...defaultScenario(), ...scenarioOverride, seed };
  const profiles = [SAMPLES[0], SAMPLES[1], SAMPLES[2]];
  const profB = [SAMPLES[3], SAMPLES[4], SAMPLES[5]];
  // Same ROBOTs on both sides whenever the AI plays a baseline, so the comparison isolates policy.
  const redProfiles = aiSide === 'red' ? profiles : profB;
  const blueProfiles = aiSide === 'red' ? profB : profiles;
  const alliances = buildAlliances(redProfiles, blueProfiles);
  const ai = createAI({
    side: aiSide,
    weights: cloneWeights(weights),
    caps: alliances[aiSide].robots.map(capOf),
    oppProfiles: alliances[aiSide === 'red' ? 'blue' : 'red'].robots,
    rngSeed: seed * 31 + 7,
    iterations,
    objective: sc.objective,
    event: sc.event,
    towerL1TeleopAllowed: sc.towerL1TeleopAllowed,
  });
  const base = makeBaseline(kind, aiSide === 'red' ? 'blue' : 'red', seed * 17 + 3);
  const res = simulateMatch({
    redAlliance: alliances.red,
    blueAlliance: alliances.blue,
    redPolicy: aiSide === 'red' ? ai : base,
    bluePolicy: aiSide === 'blue' ? ai : base,
    scenario: sc,
    record,
  });
  return { res, aiSide, kind };
}

export function capOf(rb) {
  return {
    speed: rb.driveSpeedIps,
    intake: rb.intakeRate,
    capacity: rb.capacity,
    shootRate: rb.shootRate,
    accuracy: rb.shootAccuracy,
    defenseSkill: rb.defenseSkill,
    defensePower: rb.defensePower,
    maxClimb: rb.derived.maxClimbLevel,
    climb: { max: rb.derived.maxClimbLevel, timeSec: rb.climb.timeSec, attachTimeSec: rb.climb.attachTimeSec },
    canTrench: rb.canTrench,
    reliability: rb.reliability,
    team: rb.team,
  };
}

export function sideScore(res, side) {
  const f = res.final[side];
  return { total: f.total, fuel: f.fuel, tower: f.towerTotal, rp: f.rp.total };
}

// Play the AI against one baseline over many seeds, alternating ALLIANCE colour.
export function evaluateVsBaseline({ kind, weights, matches = 30, seed = 1000, iterations = 200, scenarioOverride = {} }) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let aiTotal = 0;
  let oppTotal = 0;
  let aiRP = 0;
  let traversal = 0;
  let energized = 0;
  for (let i = 0; i < matches; i++) {
    const aiSide = i % 2 === 0 ? 'red' : 'blue';
    const { res } = runOneOpponentMatch({ kind, weights, seed: seed + i * 977, aiSide, iterations, scenarioOverride });
    const me = sideScore(res, aiSide);
    const them = sideScore(res, aiSide === 'red' ? 'blue' : 'red');
    aiTotal += me.total;
    oppTotal += them.total;
    aiRP += me.rp;
    traversal += res.final[aiSide].rp.traversal;
    energized += res.final[aiSide].rp.energized;
    if (me.total > them.total) wins += 1;
    else if (me.total < them.total) losses += 1;
    else ties += 1;
  }
  return {
    kind,
    matches,
    wins,
    losses,
    ties,
    winRate: (wins + 0.5 * ties) / matches,
    avgAiScore: aiTotal / matches,
    avgOppScore: oppTotal / matches,
    avgRP: aiRP / matches,
    traversalRate: traversal / matches,
    energizedRate: energized / matches,
  };
}

// A-vs-B over many seeds, alternating ALLIANCE colour. Either side may be 'ai' (weighted) or a
// baseline kind, which is what the benchmark panel reports as head-to-head evidence.
export function headToHead({ kindA, kindB, A = DEFAULT_WEIGHTS, B = DEFAULT_WEIGHTS, matches = 20, seed = 500, iterations = 200 }) {
  const profA = [SAMPLES[0], SAMPLES[1], SAMPLES[2]];
  const profB = [SAMPLES[3], SAMPLES[4], SAMPLES[5]];
  let aWins = 0;
  let bWins = 0;
  let aScore = 0;
  let bScore = 0;
  for (let i = 0; i < matches; i++) {
    const aSide = i % 2 === 0 ? 'red' : 'blue';
    const redProfiles = aSide === 'red' ? profA : profB;
    const blueProfiles = aSide === 'red' ? profB : profA;
    const alliances = buildAlliances(redProfiles, blueProfiles);
    const make = (which, side, weights) =>
      which === 'ai'
        ? createAI({
            side,
            weights: cloneWeights(weights),
            caps: alliances[side].robots.map(capOf),
            oppProfiles: alliances[side === 'red' ? 'blue' : 'red'].robots,
            rngSeed: (seed + i) * 13 + (side === 'red' ? 1 : 2),
            iterations,
          })
        : makeBaseline(which, side, seed + i);
    const bSide = aSide === 'red' ? 'blue' : 'red';
    const pa = make(kindA, aSide, A);
    const pb = make(kindB, bSide, B);
    const sc = { ...defaultScenario(), seed: seed + i * 613 };
    const res = simulateMatch({
      redAlliance: alliances.red,
      blueAlliance: alliances.blue,
      redPolicy: aSide === 'red' ? pa : pb,
      bluePolicy: aSide === 'red' ? pb : pa,
      scenario: sc,
    });
    const sa = sideScore(res, aSide);
    const sb = sideScore(res, bSide);
    aScore += sa.total;
    bScore += sb.total;
    if (sa.total > sb.total) aWins += 1;
    else if (sb.total > sa.total) bWins += 1;
  }
  return { matches, aWins, bWins, draws: matches - aWins - bWins, aScore: aScore / matches, bScore: bScore / matches };
}

// ---------------------------------------------------------------------------------------------
// Evolution strategy over the policy weights. (mu/rho + lambda) with adaptive step size: cheap,
// derivative-free and reliable for ~35 dimensions, and it runs happily in a Web Worker.
//
// The fitness is deliberately smooth rather than the literal Ranking Point total: RP is a step
// function (Table 6-5 thresholds), so a population sitting just under SUPERCHARGED would see a
// flat gradient. Rewarding fractional progress toward each threshold keeps the search climbing.
// ---------------------------------------------------------------------------------------------
export function smoothUtility(res, aiSide) {
  const me = res.final[aiSide];
  const them = res.final[aiSide === 'red' ? 'blue' : 'red'];
  const win = me.total > them.total ? 1 : me.total === them.total ? 0.5 : 0;
  const margin = Math.max(-150, Math.min(150, me.total - them.total));
  const fuel = me.fuel;
  const tower = me.towerTotal;
  return (
    3.0 * win +
    1.2 * Math.min(1, fuel / 360) + // SUPERCHARGED RP threshold (Table 6-5)
    0.5 * Math.min(1, fuel / 100) + // ENERGIZED RP threshold
    0.8 * Math.min(1, tower / 50) + // TRAVERSAL RP threshold
    0.004 * margin
  );
}

export function fitness({ weights, opponent = null, matches = 6, seed = 4242, iterations = 140, scenarioOverride = {} }) {
  let total = 0;
  for (let i = 0; i < matches; i++) {
    const aiSide = i % 2 === 0 ? 'red' : 'blue';
    const useSelf = opponent && i % 2 === 1;
    const sc = { ...defaultScenario(), ...scenarioOverride, seed: seed + i * 613 };
    const profiles = [SAMPLES[0], SAMPLES[1], SAMPLES[2]];
    const profB = [SAMPLES[3], SAMPLES[4], SAMPLES[5]];
    const redProfiles = aiSide === 'red' ? profiles : profB;
    const blueProfiles = aiSide === 'red' ? profB : profiles;
    const alliances = buildAlliances(redProfiles, blueProfiles);
    const me = createAI({
      side: aiSide,
      weights: cloneWeights(weights),
      caps: alliances[aiSide].robots.map(capOf),
      oppProfiles: alliances[aiSide === 'red' ? 'blue' : 'red'].robots,
      rngSeed: seed + i * 31,
      iterations,
      objective: sc.objective,
      event: sc.event,
    });
    const oppSide = aiSide === 'red' ? 'blue' : 'red';
    const other =
      useSelf
        ? createAI({
            side: oppSide,
            weights: cloneWeights(opponent),
            caps: alliances[oppSide].robots.map(capOf),
            oppProfiles: alliances[aiSide].robots,
            rngSeed: seed + i * 37,
            iterations,
            objective: sc.objective,
            event: sc.event,
          })
        : makeBaseline('greedy', oppSide, seed + i);
    const res = simulateMatch({
      redAlliance: alliances.red,
      blueAlliance: alliances.blue,
      redPolicy: aiSide === 'red' ? me : other,
      bluePolicy: aiSide === 'red' ? other : me,
      scenario: sc,
    });
    total += smoothUtility(res, aiSide);
  }
  return total / matches;
}

export function evolve({
  initial,
  generations = 12,
  lambda = 8,
  matches = 6,
  seed = 99,
  iterations = 140,
  onProgress,
  budgetMs = 20000,
  scenarioOverride = {},
  selfPlay = true,
}) {
  const rnd = makeRng(seed);
  const start = Date.now();
  let sigma = 0.25;
  let best = cloneWeights(initial);
  let bestFit = fitness({ weights: best, matches, seed, iterations, scenarioOverride, opponent: selfPlay ? cloneWeights(initial) : null });
  const history = [{ gen: 0, fit: bestFit, sigma }];
  for (let g = 1; g <= generations; g++) {
    if (Date.now() - start > budgetMs) break;
    const trials = [];
    for (let k = 0; k < lambda; k++) {
      const cand = { ...best };
      const nMut = 1 + Math.floor(rnd() * 4);
      for (let m = 0; m < nMut; m++) {
        const key = WEIGHT_KEYS[Math.floor(rnd() * WEIGHT_KEYS.length)];
        const scale = Math.max(0.05, Math.abs(best[key]) || 1);
        cand[key] = best[key] + (rnd() < 0.5 ? -1 : 1) * sigma * scale * (0.4 + rnd());
      }
      trials.push(cand);
    }
    let improved = false;
    for (const cand of trials) {
      const f = fitness({
        weights: cand,
        matches,
        seed: seed + g * 31,
        iterations,
        scenarioOverride,
        opponent: selfPlay ? best : null,
      });
      if (f > bestFit) {
        bestFit = f;
        best = cand;
        improved = true;
      }
    }
    sigma = improved ? sigma * 1.08 : sigma * 0.82;
    sigma = Math.max(0.03, Math.min(0.6, sigma));
    history.push({ gen: g, fit: bestFit, sigma });
    if (onProgress) onProgress({ gen: g, generations, fit: bestFit, sigma, best: { ...best } });
  }
  return { weights: best, fitness: bestFit, history };
}

// Simple Elo bookkeeping for the benchmark panel.
export class Elo {
  constructor(k = 24) {
    this.k = k;
    this.ratings = new Map();
    this.games = new Map();
  }

  ensure(name) {
    if (!this.ratings.has(name)) this.ratings.set(name, 1500);
    return this.ratings.get(name);
  }

  expect(a, b) {
    return 1 / (1 + 10 ** ((this.ensure(b) - this.ensure(a)) / 400));
  }

  record(a, b, scoreA) {
    const ea = this.expect(a, b);
    this.ratings.set(a, this.ensure(a) + this.k * (scoreA - ea));
    this.ratings.set(b, this.ensure(b) + this.k * (1 - scoreA - (1 - ea)));
    this.games.set(a, (this.games.get(a) || 0) + 1);
    this.games.set(b, (this.games.get(b) || 0) + 1);
  }

  table() {
    return [...this.ratings.entries()].map(([name, r]) => ({ name, rating: Math.round(r), games: this.games.get(name) || 0 })).sort((x, y) => y.rating - x.rating);
  }
}

// Does the analytic model the MCTS searches with actually track the engine? Both sides play the
// same greedy plan, so the only difference is the model. Reported in the UI as an error bar on
// every search-derived recommendation.
export function fastModelVsEngine({ samples = 6, seed = 7, weights = DEFAULT_WEIGHTS } = {}) {
  const profRed = [SAMPLES[0], SAMPLES[1], SAMPLES[2]];
  const profBlue = [SAMPLES[3], SAMPLES[4], SAMPLES[5]];
  let engineRed = 0;
  let engineBlue = 0;
  for (let i = 0; i < samples; i++) {
    const sc = { ...defaultScenario(), seed: (seed + i * 313) >>> 0 };
    const red = makeAlliance(profRed, 'red');
    const blue = makeAlliance(profBlue, 'blue');
    const res = simulateMatch({ redAlliance: red, blueAlliance: blue, redPolicy: greedyPolicy('red'), bluePolicy: greedyPolicy('blue'), scenario: sc });
    engineRed += res.final.red.total;
    engineBlue += res.final.blue.total;
  }
  engineRed /= samples;
  engineBlue /= samples;

  // Equivalent plan for the analytic model: everyone cycles, one TOWER ladder at the end.
  const sched = hubActiveTable('red');
  const plan = emptyPlan();
  for (const row of sched) if (row.period !== 'AUTO') plan.periods[row.period] = [ROLE.SCORE, ROLE.SCORE, ROLE.SCORE];
  plan.climb = { count: 3, levels: [3, 3, 2], startAt: TIME.matchSec - TIME.endgameSec + 4 };
  plan.auto = { fuelTarget: 1, climbCount: 0 };
  const ctx = makeContext({
    schedule: sched,
    caps: {
      red: makeAlliance(profRed, 'red').robots.map(capOf),
      blue: makeAlliance(profBlue, 'blue').robots.map(capOf),
    },
    event: 'regional',
    objective: 'rs',
    weights,
  });
  const est = evaluateMatch(ctx, 'red', plan, plan, { spread: 0.18 });
  const modelRed = est.ownScore;
  const modelBlue = est.oppScore;
  return {
    samples,
    engineRed,
    engineBlue,
    modelRed,
    modelBlue,
    errRedPct: ((modelRed - engineRed) / Math.max(1, engineRed)) * 100,
    errBluePct: ((modelBlue - engineBlue) / Math.max(1, engineBlue)) * 100,
  };
}

// The analytic model is a fluid approximation, so it has a systematic scale error against the
// engine. Rather than hand-tuning a fudge factor, calibrate it at load: run a few real greedy-vs-
// greedy MATCHES, compute the raw model estimate for the same plan, and fit the ratio. The
// residual after calibration is reported in the UI so the search's assumption stays auditable.
export function calibrateModel({ weights = DEFAULT_WEIGHTS, samples = 4, seed = 7, climbLevels = [3, 3, 3], startAt = TIME.matchSec - 14 } = {}) {
  const profRed = [SAMPLES[0], SAMPLES[1], SAMPLES[2]];
  const profBlue = [SAMPLES[3], SAMPLES[4], SAMPLES[5]];
  let engineRed = 0;
  let engineBlue = 0;
  for (let i = 0; i < samples; i++) {
    const sc = { ...defaultScenario(), seed: (seed + i * 313) >>> 0 };
    const red = makeAlliance(profRed, 'red');
    const blue = makeAlliance(profBlue, 'blue');
    const res = simulateMatch({ redAlliance: red, blueAlliance: blue, redPolicy: greedyPolicy('red'), bluePolicy: greedyPolicy('blue'), scenario: sc });
    engineRed += res.final.red.total;
    engineBlue += res.final.blue.total;
  }
  engineRed /= samples;
  engineBlue /= samples;

  const raw = cloneWeights(weights);
  raw.modelEfficiency = 1;
  const sched = hubActiveTable('red');
  const plan = emptyPlan();
  for (const row of sched) if (row.period !== 'AUTO') plan.periods[row.period] = [ROLE.SCORE, ROLE.SCORE, ROLE.SCORE];
  plan.climb = { count: 3, levels: climbLevels, startAt };
  plan.auto = { fuelTarget: 1, climbCount: 0 };
  const ctx = makeContext({
    schedule: sched,
    caps: {
      red: makeAlliance(profRed, 'red').robots.map(capOf),
      blue: makeAlliance(profBlue, 'blue').robots.map(capOf),
    },
    event: 'regional',
    objective: 'rs',
    weights: raw,
  });
  const est = evaluateMatch(ctx, 'red', plan, plan, { spread: 0.18 });
  const rawMean = (est.ownScore + est.oppScore) / 2;
  const engineMean = (engineRed + engineBlue) / 2;
  const efficiency = Math.max(0.3, Math.min(2.6, engineMean / Math.max(1, rawMean)));
  const calibrated = cloneWeights(weights);
  calibrated.modelEfficiency = efficiency;
  const ctx2 = makeContext({
    schedule: sched,
    caps: ctx.caps,
    event: 'regional',
    objective: 'rs',
    weights: calibrated,
  });
  const est2 = evaluateMatch(ctx2, 'red', plan, plan, { spread: 0.18 });
  return {
    efficiency,
    engineRed,
    engineBlue,
    rawRed: est.ownScore,
    rawBlue: est.oppScore,
    calibratedRed: est2.ownScore,
    calibratedBlue: est2.oppScore,
    errRedPct: ((est2.ownScore - engineRed) / Math.max(1, engineRed)) * 100,
    errBluePct: ((est2.oppScore - engineBlue) / Math.max(1, engineBlue)) * 100,
    samples,
  };
}

export { periodAt, POINTS, TIME };
