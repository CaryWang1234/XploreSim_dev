// Search-based coach AI for REBUILT.
//
// Three layers, matching how a real ALLIANCE actually plans:
//   1. Macro  - an MCTS over per-period role assignments and the END GAME climb ladder, scored
//               with the analytic model (fastsim) against a Bayesian opponent model. This is
//               where the HUB-window trade-offs and the "win AUTO -> idle in SHIFT 1" handicap
//               get resolved.
//   2. Micro  - per-ROBOT utility policy: FUEL cluster targeting with G408 avoidance, sticky
//               score/collect tempo, defence assignment, TOWER lane allocation.
//   3. Weights- the micro and macro parameters are a flat vector tuned by self-play evolution
//               in league.js, with Elo against named baselines to keep the claim honest.
//
// Every number a policy uses about the OPPONENT comes from a noisy scouting report plus in-MATCH
// observation, never from the opponent's true parameters.

import { TIME, POINTS, FIELD, hubActiveTable } from './rules.js';
import { GEO, INTENT } from './engine.js';
import {
  ROLE,
  PERIODS,
  periodSeconds,
  makeContext,
  evaluateMatch,
  emptyPlan,
  roleCandidates,
  withRoles,
  withClimb,
  withAuto,
  NEAR_FUEL,
} from './fastsim.js';
import { ARCHETYPES } from './model.js';

// ---------------------------------------------------------------------------------------------
// Tunable weights. league.js evolves this vector by self-play; the defaults below are the
// starting point and are already playable on their own.
// ---------------------------------------------------------------------------------------------
export const DEFAULT_WEIGHTS = {
  // fast-model shape (also evolved, because they steer which strategy looks best)
  loadSeconds: 6.0,
  traversalOverhead: 1.6,
  aimOverhead: 1.1,
  defenseEfficacy: 0.55,
  bankCredit: 0.35,
  // FUEL cluster targeting
  clusterDensity: 1.0,
  clusterNear: 0.0022,
  clusterHubExitPenalty: 1.6,
  clusterOwnHalfBias: 0.3,
  clusterStickiness: 0.55,
  targetRefreshSec: 0.6,
  // tempo
  dumpThreshold: 0.85,
  dumpBeforeIdleFrac: 0.3,
  dumpBeforeIdleSec: 3.0,
  idleStockpileFrac: 0.92,
  // defence
  defendCarryWeight: 0.6,
  defendThreatWeight: 0.5,
  defendMinRemainingSec: 4,
  defendPerRobot: 1,
  // TOWER
  climbTraversalFocus: 1.0,
  climbReserveSec: 17,
  climbLevelBias: 0.15,
  // AUTO
  autoFuelTarget: 1.0,
  autoClimbCount: 1,
  // risk
  pinRiskWeight: 0.5,
  g408RiskWeight: 1.0,
  // search
  mctsExploration: 0.75,
  modelEfficiency: 0.85, // scales the analytic model to the engine's observed output
};

export const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS);

export function cloneWeights(w) {
  return { ...DEFAULT_WEIGHTS, ...w };
}

// ---------------------------------------------------------------------------------------------
// Scouting: a noisy capability estimate, never the true profile.
// ---------------------------------------------------------------------------------------------
export function scoutCaps(profiles, rng, noise = 0.12) {
  const jitter = (v, lo = 0.05) => Math.max(lo, v * (1 + rng.gauss(0, noise)));
  return profiles.map((p) => {
    const climbGuess = rng.chance(0.82) ? p.climb : rng.chance(0.5) ? { ...p.climb, l3: false } : { ...p.climb, l2: false, l3: false };
    const max = climbGuess.l3 ? 3 : climbGuess.l2 ? 2 : climbGuess.l1 ? 1 : 0;
    return {
      speed: jitter(p.driveSpeedIps, 40),
      intake: jitter(p.intakeRate, 0.5),
      capacity: jitter(p.capacity, 3),
      shootRate: jitter(p.shootRate, 0.5),
      accuracy: Math.min(0.99, jitter(p.shootAccuracy, 0.4)),
      defenseSkill: Math.min(1, jitter(Math.max(0.1, p.defenseSkill), 0.2)),
      defensePower: Math.min(1, jitter(Math.max(0.1, p.defensePower), 0.2)),
      maxClimb: max,
      climb: { max, timeSec: jitter(p.climb.timeSec, 2), attachTimeSec: jitter(p.climb.attachTimeSec, 1) },
      canTrench: p.heightIn <= FIELD.trench.clearHeightIn,
      reliability: p.reliability,
      team: p.team,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Bayesian opponent model over the archetypes in model.js. Observations are public: AUTO FUEL,
// how the opponent splits its ROBOTs between scoring / defending / climbing, and how much FUEL
// it has banked into the HUB.
// ---------------------------------------------------------------------------------------------
const ARCH_FEATURES = {
  rush: { score: 0.78, defend: 0.04, climb: 0.1, climbLvl: 0.35, autoFuel: 0.7 },
  balanced: { score: 0.58, defend: 0.14, climb: 0.16, climbLvl: 0.7, autoFuel: 0.55 },
  defensive: { score: 0.4, defend: 0.4, climb: 0.14, climbLvl: 0.4, autoFuel: 0.4 },
  climber: { score: 0.45, defend: 0.08, climb: 0.4, climbLvl: 1.0, autoFuel: 0.4 },
  cycler: { score: 0.72, defend: 0.03, climb: 0.1, climbLvl: 0.25, autoFuel: 0.6 },
};

export class OpponentModel {
  constructor(side) {
    this.side = side;
    this.counts = {};
    for (const a of ARCHETYPES) this.counts[a.key] = 1;
    this.observed = { score: 0.62, defend: 0.12, climb: 0.16, climbLvl: 0.5, autoFuel: 0.5 };
    this.samples = 1;
  }

  posterior() {
    const total = Object.values(this.counts).reduce((a, b) => a + b, 0);
    const out = {};
    for (const k of Object.keys(this.counts)) out[k] = this.counts[k] / total;
    return out;
  }

  // Gaussian likelihood over the feature vector; each new observation nudges the posterior.
  update(feat, weight = 1) {
    const keys = Object.keys(ARCH_FEATURES);
    const sd = { score: 0.22, defend: 0.2, climb: 0.2, climbLvl: 0.35, autoFuel: 0.3 };
    for (const k of keys) {
      const c = ARCH_FEATURES[k];
      let ll = 0;
      for (const f of Object.keys(sd)) {
        const d = (feat[f] - c[f]) / sd[f];
        ll += -0.5 * d * d;
      }
      this.counts[k] += Math.exp(ll / Object.keys(sd).length) * weight;
    }
    this.observed = { ...this.observed, ...feat };
    this.samples += 1;
  }

  // Sample a full opponent plan consistent with the posterior (used for MCTS rollouts).
  samplePlan(ctx, rng, sched) {
    const post = this.posterior();
    let r = rng();
    let key = ARCHETYPES[0].key;
    for (const a of ARCHETYPES) {
      r -= post[a.key];
      if (r <= 0) {
        key = a.key;
        break;
      }
    }
    const arch = ARCHETYPES.find((a) => a.key === key);
    return planFromArchetype(arch, sched, rng);
  }
}

// Turn an archetype's macro bias into a concrete plan: roles per period, a climb ladder and an
// AUTO posture. Randomised so rollouts explore the archetype's neighbourhood rather than one point.
export function planFromArchetype(arch, sched, rng) {
  const plan = emptyPlan();
  const bias = arch.weights.macroBias;
  const pick = (period) => {
    const roles = [];
    for (let i = 0; i < 3; i++) {
      const r = rng();
      let acc = 0;
      let chosen = ROLE.SCORE;
      for (const [k, v] of [
        [ROLE.SCORE, bias.SCORE],
        [ROLE.DEFEND, bias.DEFEND],
        [ROLE.CLIMB, bias.CLIMB],
      ]) {
        acc += v;
        if (r <= acc) {
          chosen = k;
          break;
        }
      }
      roles.push(chosen);
    }
    if (!roles.includes(ROLE.SCORE)) roles[0] = ROLE.SCORE;
    return roles;
  };
  for (const row of sched) {
    if (row.period === 'AUTO') continue;
    plan.periods[row.period] = pick(row.period);
  }
  const cp = arch.weights.climbPriority;
  const count = Math.max(0, Math.min(3, Math.round(cp * 3)));
  plan.climb = {
    count,
    levels: [3, 3, 2],
    startAt: TIME.matchSec - TIME.endgameSec + (cp > 0.6 ? 3 : 12),
  };
  plan.auto = { fuelTarget: 0.6 + 0.4 * (1 - cp), climbCount: cp > 0.6 ? 1 : 0 };
  return plan;
}

// ---------------------------------------------------------------------------------------------
// MCTS. Nodes are (period, role assignment); rollouts complete the remaining periods from the
// prior and draw the opponent's plan from the posterior. Two levels are expanded so the search
// can see the interaction between consecutive SHIFTs (e.g. defend now, dump next SHIFT).
// ---------------------------------------------------------------------------------------------
export class MacroPlanner {
  constructor(ctx, oppModel, weights) {
    this.ctx = ctx;
    this.opp = oppModel;
    this.w = weights;
    this.candidates = roleCandidates(3);
  }

  rollout(ownPlanPartial, sched, fromIdx, rng) {
    let plan = ownPlanPartial;
    for (let i = fromIdx; i < sched.length; i++) {
      const row = sched[i];
      if (row.period === 'AUTO') continue;
      const c = this.candidates[rng.int(this.candidates.length)];
      plan = withRoles(plan, row.period, c);
    }
    const oppPlan = this.opp.samplePlan(this.ctx, rng, sched);
    return evaluateMatch(this.ctx, this.side, plan, oppPlan, { spread: 0.18 });
  }

  search(side, sched, basePlan, fromIdx, iterations = 260, seed = 1) {
    this.side = side;
    const rng = makeRolloutRng(seed);
    const other = side === 'red' ? 'blue' : 'red';
    const ownActions = this.candidates;
    const nextIdx = nextPlayable(sched, fromIdx);

    // Depth-2 tree: for each candidate now, and each candidate in the next period.
    const tree = ownActions.map((a) => ({
      action: a,
      visits: 0,
      value: 0,
      children: nextIdx >= 0 ? ownActions.map((b) => ({ action: b, visits: 0, value: 0 })) : null,
      bestChild: 0,
    }));

    for (let it = 0; it < iterations; it++) {
      // --- selection at the root (UCB1) ---
      let node = tree[0];
      let bestU = -Infinity;
      for (const n of tree) {
        const u = n.visits === 0 ? Infinity : n.value / n.visits + this.w.mctsExploration * Math.sqrt(Math.log(it + 1) / n.visits);
        if (u > bestU) {
          bestU = u;
          node = n;
        }
      }
      let planNow = withRoles(basePlan, sched[fromIdx].period, node.action);
      let child = null;
      if (node.children && nextIdx >= 0) {
        let bestCU = -Infinity;
        for (const c of node.children) {
          const u = c.visits === 0 ? Infinity : c.value + this.w.mctsExploration * Math.sqrt(Math.log(node.visits + 1) / c.visits);
          if (u > bestCU) {
            bestCU = u;
            child = c;
          }
        }
        if (child) planNow = withRoles(planNow, sched[nextIdx].period, child.action);
      }

      // --- simulation ---
      const res = this.rollout(planNow, sched, nextIdx + 1, rng);

      // --- backpropagation ---
      node.visits += 1;
      node.value += res.utility;
      if (child) {
        child.visits += 1;
        child.value += res.utility;
      }
    }

    let best = tree[0];
    for (const n of tree) if (n.visits > 0 && n.value / n.visits > best.value / Math.max(1, best.visits)) best = n;
    return { action: best.action, value: best.value / Math.max(1, best.visits), visits: best.visits, totalRollouts: iterations };
  }

  // END GAME adds the climb ladder to the decision: how many ROBOTs to send, at which LEVELs, and
  // when to leave the FUEL cycle. TOWER points are evaluated after the MATCH (§6.5-D).
  searchEndgame(side, sched, basePlan, fromIdx, iterations = 300, seed = 1, towerL1TeleopAllowed = true) {
    this.side = side;
    const rng = makeRolloutRng(seed);
    const opts = [];
    for (const count of [0, 1, 2, 3]) {
      for (const levels of climbLevelSets(count)) {
        for (const startAt of [TIME.matchSec - TIME.endgameSec + 2, TIME.matchSec - TIME.endgameSec + 8, TIME.matchSec - 14]) {
          opts.push({ count, levels, startAt });
        }
      }
    }
    let best = null;
    for (const opt of opts) {
      let sum = 0;
      let n = Math.min(iterations, 26);
      for (let i = 0; i < n; i++) {
        const roles = this.candidates[rng.int(this.candidates.length)];
        let plan = withClimb(withRoles(basePlan, 'END GAME', roles), opt);
        plan = this.completeRest(plan, sched, fromIdx, rng);
        const oppPlan = this.opp.samplePlan(this.ctx, rng, sched);
        const res = evaluateMatch(this.ctx, side, plan, oppPlan, { spread: 0.18, towerL1TeleopAllowed });
        const bonus = this.w.climbTraversalFocus * (hasTraversal(plan, towerL1TeleopAllowed) ? 0.35 : 0);
        sum += res.utility + bonus;
      }
      const v = sum / n;
      if (!best || v > best.value) best = { value: v, opt };
    }
    return { climb: best.opt, value: best.value, totalRollouts: opts.length * Math.min(iterations, 26) };
  }

  completeRest(plan, sched, fromIdx, rng) {
    let out = plan;
    for (let i = fromIdx + 1; i < sched.length; i++) {
      const row = sched[i];
      if (row.period === 'AUTO') continue;
      out = withRoles(out, row.period, this.candidates[rng.int(this.candidates.length)]);
    }
    return out;
  }

  // AUTO posture: how much FUEL to spend shooting, how many ROBOTs to send up for LEVEL 1.
  // Scoring more FUEL in AUTO wins the AUTO result, which makes your own HUB inactive in SHIFT 1
  // (Table 6-3), so this is a genuine trade rather than "always shoot everything".
  searchAuto(side, sched, basePlan, iterations = 90, seed = 7, towerL1TeleopAllowed = true) {
    this.side = side;
    const rng = makeRolloutRng(seed);
    let best = null;
    for (const fuelTarget of [0.25, 0.5, 0.75, 1.0]) {
      for (let autoClimb = 0; autoClimb <= 2; autoClimb++) {
        let sum = 0;
        const n = Math.max(8, Math.round(iterations / 12));
        for (let i = 0; i < n; i++) {
          let plan = withAuto(basePlan, { fuelTarget, climbCount: autoClimb });
          plan = this.completeRest(plan, sched, -1, rng);
          const oppPlan = this.opp.samplePlan(this.ctx, rng, sched);
          const res = evaluateMatch(this.ctx, side, plan, oppPlan, { spread: 0.18, towerL1TeleopAllowed });
          sum += res.utility;
        }
        const v = sum / n;
        if (!best || v > best.value) best = { value: v, auto: { fuelTarget, climbCount: autoClimb } };
      }
    }
    return { auto: best.auto, value: best.value, totalRollouts: 8 * 8 };
  }
}

function climbLevelSets(count) {
  if (count === 0) return [[]];
  if (count === 1) return [[3], [2], [1]];
  if (count === 2) return [[3, 2], [3, 3], [2, 2], [3, 1]];
  return [[3, 3, 3], [3, 3, 2], [3, 2, 2], [3, 3, 1]];
}

function hasTraversal(plan, towerL1TeleopAllowed) {
  let tower = 0;
  for (let i = 0; i < plan.climb.count; i++) {
    const l = plan.climb.levels[i] || 3;
    tower += l === 1 ? (towerL1TeleopAllowed ? POINTS.tower.l1Teleop : 0) : l === 2 ? POINTS.tower.l2Teleop : POINTS.tower.l3Teleop;
  }
  return tower >= POINTS.rpThreshold.traversal.regional;
}

function nextPlayable(sched, fromIdx) {
  for (let i = fromIdx + 1; i < sched.length; i++) if (sched[i].period !== 'AUTO') return i;
  return -1;
}

function makeRolloutRng(seed) {
  let a = (seed * 2654435761) >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (n) => Math.floor(rng() * n);
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.chance = (p) => rng() < p;
  return rng;
}
