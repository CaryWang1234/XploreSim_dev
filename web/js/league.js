// Baselines, match running and evolution. Used headlessly (scripts/bench.mjs) and in the browser
// worker to train the micro-policy weights by self-play, with Elo against named baselines so the
// claim "the AI is strong" is backed by a number rather than an assertion.

import { TIME, POINTS, FIELD } from './rules.js';
import { GEO, INTENT, simulateMatch } from './engine.js';
import { defaultScenario, makeAlliance, SAMPLES, periodAt } from './model.js';
import { hubActiveTable } from './rules.js';
import { makeContext, evaluateMatch, emptyPlan, withClimb, withRoles, ROLE } from './fastsim.js';
import { DEFAULT_WEIGHTS, WEIGHT_KEYS, cloneWeights, clampWeights, humanChoice, worthDelivering } from './ai.js';
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

// Every baseline runs the same HUMAN PLAYER rule as the AI at its default weights. The baselines are
// the yardstick for the ROBOT policy, so letting them also differ at the OUTPOST would make an
// AI-vs-baseline number mean two things at once.
const humanBaseline = (obs, side) => humanChoice(obs, side);

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
    human: humanBaseline,
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
    human: humanBaseline,
  };
}

// 3. greedy: HUB-window aware (never wastes FUEL), nearest-FUEL cycling, climbs its best level at the
//    end with every ROBOT. This is the "competent human plan" yardstick the AI has to beat, so it
//    also knows the one thing a competent human knows: do not loiter at a HUB exit, because catching
//    FUEL there is a G408 foul and the FUEL that comes out of a HUB lands right next to it.
const HUB_EXITS = ['red', 'blue'].map((s) => ({
  x: GEO[s].hub.x + (s === 'red' ? FIELD.hub.sizeIn / 2 : -FIELD.hub.sizeIn / 2),
  y: GEO[s].hub.y,
}));
const forbiddenFuelSpot = (x, y) => HUB_EXITS.some((e) => Math.hypot(x - e.x, y - e.y) < GEO.hubExitZoneRadiusIn + 10);

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
      // Nothing to score this window and nothing left to bank: hand the load to the HUMAN PLAYER at
      // the OUTPOST instead of sitting on it. Same rule as the AI's, so a head-to-head isolates the
      // ROBOT policy rather than which side happens to use its OUTPOST.
      if (worthDelivering(obs, side, rb)) return { mode: INTENT.FEED };
      if (!active && rb.carrying >= rb.capacity) return { mode: INTENT.STOCKPILE, target: g.shootStations[rb.slot] };
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < obs.fuel.total; i += 2) {
        if (obs.fuel.state[i] !== 0) continue;
        if (forbiddenFuelSpot(obs.fuel.x[i], obs.fuel.y[i])) continue;
        const d = (obs.fuel.x[i] - rb.x) ** 2 + (obs.fuel.y[i] - rb.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x: obs.fuel.x[i], y: obs.fuel.y[i] };
        }
      }
      return best ? { mode: INTENT.COLLECT, target: best } : { mode: INTENT.STOCKPILE, target: g.shootStations[rb.slot] };
    },
    human: humanBaseline,
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

// The six sample cards make two trios, and every comparison in this file used to put one trio on each
// side: the AI always drove 254/1678/1690 and its opponent always drove 4414/5940/11019. That is not a
// mirror, and the rosters are not equal — greedy against greedy, one trio per side, scores 592.5 with
// the first and 652.3 with the second, so 59.8 of the "AI is only 26.3% against greedy" figure was the
// roster the AI happened to be dealt, not its policy.
//
// A MATCH is now played with the SAME trio on both sides and the trio alternates across the sample, so
// each match isolates policy and the set still covers both rosters.
const ROSTERS = [[SAMPLES[0], SAMPLES[1], SAMPLES[2]], [SAMPLES[3], SAMPLES[4], SAMPLES[5]]];
const mirroredRosters = (i) => ROSTERS[Math.abs(i) % ROSTERS.length];

// `aiOptions` reaches createAI verbatim and is how an ablation is expressed: planOverride pins the
// macro plan (so the search is skipped), debug collects the decision log. It is spread FIRST so it
// can never quietly change which ROBOTs are on the field or which side the AI plays.
export function runOneOpponentMatch({ kind, weights, seed, record = false, scenarioOverride = {}, aiSide = 'red', iterations = 200, aiOptions = {}, rosterIdx = null }) {
  const sc = { ...defaultScenario(), ...scenarioOverride, seed };
  const profiles = mirroredRosters(rosterIdx === null ? seed : rosterIdx);
  const alliances = buildAlliances(profiles, profiles);
  const ai = createAI({
    ...aiOptions,
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
    mechanism: rb.mechanism,
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
export function evaluateVsBaseline({ kind, weights, matches = 30, seed = 1000, iterations = 200, scenarioOverride = {}, aiOptions = {}, seat = null }) {
  let wins = 0;
  let losses = 0;
  let ties = 0;
  let aiTotal = 0;
  let oppTotal = 0;
  let aiRP = 0;
  let traversal = 0;
  let energized = 0;
  for (let i = 0; i < matches; i++) {
    // Alternating seats is the default because the two are not equivalent, and `seat` pins one so the
    // Tactics tab's red/blue selector can ask the question a user asks. The seat changes every TWO
    // MATCHes while the roster changes every MATCH (i % 2), which crosses them: had both alternated on
    // i, a pinned seat would also be a pinned roster and "red 21.9% vs blue 32.0%" would have been
    // partly two different ROBOTs.
    const aiSide = seat === 'red' || seat === 'blue' ? seat : Math.floor(i / 2) % 2 === 0 ? 'red' : 'blue';
    const { res } = runOneOpponentMatch({ kind, weights, seed: seed + i * 977, aiSide, rosterIdx: i % 2, iterations, scenarioOverride, aiOptions });
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
  let aWins = 0;
  let bWins = 0;
  let aScore = 0;
  let bScore = 0;
  for (let i = 0; i < matches; i++) {
    // Both sides fly the SAME trio every MATCH (see mirroredRosters), and the seat turns over every two
    // MATCHes while the trio turns over every one, so neither arm is dealt the better ROBOTs.
    const aSide = Math.floor(i / 2) % 2 === 0 ? 'red' : 'blue';
    const profiles = mirroredRosters(i % 2);
    const alliances = buildAlliances(profiles, profiles);
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
// Evolution strategy over the policy weights. (mu + lambda) with adaptive step size: cheap,
// derivative-free and reliable for ~20 dimensions, and it runs happily in a Web Worker.
//
// The fitness is deliberately smooth rather than the literal Ranking Point total: RP is a step
// function (Table 6-5 thresholds), so a population sitting just under SUPERCHARGED would see a
// flat gradient. Rewarding fractional progress toward each threshold keeps the search climbing.
//
// SELECTION IS PAIRED. The incumbent is re-scored inside every generation, on that generation's
// seeds and against that generation's opponent, and competes with the mutants. The version before
// this carried `bestFit` across generations while scoring the mutants on `seed + g * 31`, so
// "improved" was decided by comparing two fitness values measured on different MATCHes — the search
// could accept a worse vector and did: with 8 MATCHes per evaluation the seed-to-seed spread of the
// same weights is larger than the improvement it was looking for.
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

// Set `families` above 1 to spread the MATCHes over that many disjoint seed families instead of
// spending them all on one. A single family is a FIXED set of FUEL layouts, and a weight vector can
// exploit the particular ones it holds: a 10-generation run on one family raised its own fitness by
// +0.9 (four times the seed-to-seed spread of the same weights) and then lost 40 MATCH points a
// match on seeds it had never seen. Averaging over families is what makes this score track the part
// that transfers, at the same total MATCH cost.
const FAMILY_STRIDE = 1000003;
export { FAMILY_STRIDE };

// The per-MATCH utilities, which is what a paired comparison needs: two weight vectors scored on the
// SAME seed set differ by luck in the layouts they were dealt, and subtracting MATCH by MATCH cancels
// that luck. `fitness` is just the mean of this, so every number measured with it stays comparable.
export function fitnessTrace({ weights, opponent = null, matches = 6, seed = 4242, iterations = 140, scenarioOverride = {}, families = 1 }) {
  const fams = Math.max(1, Math.min(families, matches));
  const out = [];
  for (let i = 0; i < matches; i++) {
    const aiSide = Math.floor(i / 2) % 2 === 0 ? 'red' : 'blue';
    const useSelf = opponent && i % 2 === 1;
    const sc = { ...defaultScenario(), ...scenarioOverride, seed: (seed + (i % fams) * FAMILY_STRIDE + Math.floor(i / fams) * 613) >>> 0 };
    // The same trio on both sides, and the trio turns over on i while the seat turns over on i/2, so a
    // weight vector cannot be fitted to one roster and then judged as if it had flown both.
    const profiles = mirroredRosters(i % 2);
    const alliances = buildAlliances(profiles, profiles);
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
    out.push(smoothUtility(res, aiSide));
  }
  return out;
}

export function fitness({ weights, opponent = null, matches = 6, seed = 4242, iterations = 140, scenarioOverride = {}, families = 1 }) {
  const v = fitnessTrace({ weights, opponent, matches, seed, iterations, scenarioOverride, families });
  return v.reduce((a, b) => a + b, 0) / v.length;
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
  // Which weights to mutate. The full vector is ~20 dimensions, and a budget large enough to resolve
  // a change in all of them at once is far larger than one large enough to resolve it in six, so a
  // short run should name the axes it is allowed to move instead of spreading its samples thin.
  keys = WEIGHT_KEYS,
  // How many disjoint seed families each evaluation spends its MATCHes on (see fitness).
  families = 1,
}) {
  const rnd = makeRng(seed);
  const start = Date.now();
  let sigma = 0.25;
  let best = cloneWeights(initial);
  const movable = keys.length ? keys : WEIGHT_KEYS;
  const seedsFor = (g) => seed + g * 31;
  let bestFit = fitness({ weights: best, matches, seed: seedsFor(0), iterations, scenarioOverride, opponent: selfPlay ? cloneWeights(initial) : null, families });
  const history = [{ gen: 0, fit: bestFit, sigma }];
  for (let g = 1; g <= generations; g++) {
    if (Date.now() - start > budgetMs) break;
    // One seed set and one opponent for the whole generation, incumbent included, so every value
    // compared below is measured on the same MATCHes.
    const genSeed = seedsFor(g);
    const opponent = selfPlay ? best : null;
    const trials = [best];
    for (let k = 0; k < lambda; k++) {
      const cand = { ...best };
      const nMut = 1 + Math.floor(rnd() * 4);
      for (let m = 0; m < nMut; m++) {
        const key = movable[Math.floor(rnd() * movable.length)];
        const scale = Math.max(0.05, Math.abs(best[key]) || 1);
        cand[key] = best[key] + (rnd() < 0.5 ? -1 : 1) * sigma * scale * (0.4 + rnd());
      }
      trials.push(clampWeights(cand));
    }
    let genBest = best;
    let genBestFit = -Infinity;
    const fits = [];
    for (const cand of trials) {
      const f = fitness({ weights: cand, matches, seed: genSeed, iterations, scenarioOverride, opponent, families });
      fits.push(f);
      if (f > genBestFit) {
        genBestFit = f;
        genBest = cand;
      }
    }
    // The candidates in one generation differ from each other mostly by luck, since they were scored
    // on the same MATCHes and differ by a few weights. Their spread is therefore a FREE estimate of
    // the selection noise at this sample size, and it is what says whether `fit` moved at all.
    const fMean = fits.reduce((a, b) => a + b, 0) / fits.length;
    const spread = Math.sqrt(fits.reduce((a, b) => a + (b - fMean) ** 2, 0) / fits.length);
    // `fits[0]` is the incumbent scored on THIS generation's MATCHes, which is the only value the
    // mutants may be compared against — carrying last generation's score forward would compare two
    // measurements made on different seeds and call the difference an improvement.
    const incumbentFit = fits[0];
    const improved = genBestFit > incumbentFit;
    if (improved) {
      best = genBest;
      bestFit = genBestFit;
    } else {
      bestFit = incumbentFit;
    }
    sigma = improved ? sigma * 1.08 : sigma * 0.82;
    sigma = Math.max(0.03, Math.min(0.6, sigma));
    history.push({ gen: g, fit: bestFit, sigma, spread });
    if (onProgress) onProgress({ gen: g, generations, fit: bestFit, sigma, spread, best: { ...best } });
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
