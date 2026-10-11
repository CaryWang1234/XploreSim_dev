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

import { TIME, POINTS, FUEL, FIELD, hubActiveTable } from './rules.js';
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
// Tunable weights. league.js evolves this vector by self-play inside the browser, and
// scripts/train.mjs does the same offline without a budget cap, but the values below are not a
// bare starting point: they are the output of a run that was gated on a holdout seed family, and
// were only promoted because they beat the previous defaults there and on four further
// independent seed families (~85% head-to-head on identical ROBOTs, ~+40 MATCH points).
// ---------------------------------------------------------------------------------------------
export const DEFAULT_WEIGHTS = {
  // fast-model shape (also evolved, because they steer which strategy looks best)
  traversalOverhead: 1.6,
  aimOverhead: 0.8561,
  // 0 ships, and that 0 is now a measured verdict rather than a hedge. Two facts:
  //
  // (1) The play is real. `scripts/defcal.mjs` pins both sides' plans (no search involved) and sets the
  // defender count k; over 48 MATCHes per arm with one trio on both ALLIANCES, one ROBOT standing in the
  // lane costs the attacker a factor of 0.923 (254/1678/1690) and 0.935 (4414/5940/11019), and the cost
  // grows with k (0.819 at two, 0.695 at three) because a blocked launch loses the whole trip, not the
  // point. fastsim.js now charges that per defender instead of one factor for the strongest one.
  //
  // (2) The search cannot be given the number yet. Setting it to the fitted 0.1 and A/B-ing it against
  // the same weight at 0 — 96 MATCHes, four disjoint seed families — COST 9.9 points of win rate, 14.1
  // of score and 8.9 of margin, and the reason is visible in the dark-window mix: DEFEND goes from 16.1%
  // of frames to 26.6% and COLLECT falls from 63.3% to 54.9%. The model prices what a defender takes from
  // the opponent and under-prices what it costs its own side: a DEFEND role in an INACTIVE window looks
  // nearly free because that ROBOT could not score anyway, when the engine is losing the whole bank it
  // would have carried into the next window (bankCredit is one hopper, not 25 s of sweeping).
  //
  // So the geometry is in the model and the price stays at 0 until the cost side is fixed with it. A
  // half-priced play is worse than an unpriced one: it moves the decision without moving the ledger.
  defenseEfficacy: 0,
  bankCredit: 0.2434,
  // FUEL cluster targeting
  clusterDensity: 1.0419,
  clusterNear: 0.0005,
  clusterHubExitPenalty: 1.6015,
  clusterOwnHalfBias: 0.2575,
  clusterStickiness: 0.7216,
  targetRefreshSec: 0.6,
  // How hard a candidate pile is priced down for having a partner near it, at the partner's body or at
  // the target the partner is already driving at. Two ROBOTs on one pile empty it no faster and shove
  // each other doing it. 0 turns separation off and leaves only the per-tick grid claim, which is the
  // control this value was measured against: worth 7.3 win points and 6.2 of score at n=96.
  mateSeparation: 0.6,
  // tempo. dumpThreshold was pinned at 1.0 (the old upper bound), which meant the AI would only ever
  // score a completely full hopper: it would spend a whole SHIFT filling and then miss the window,
  // travel more than the greedy baseline and score less. The bound now reaches down to 0.15 so the
  // search can trade load size against window time instead of sitting on a boundary.
  dumpThreshold: 0.5,
  dumpBeforeIdleFrac: 0.2606,
  dumpBeforeIdleSec: 3.2918,
  // While our own HUB is inactive the opponent's is the active one (Table 6-3), so a ROBOT that is
  // this full cannot bank any more and goes to deny their window instead of waiting at our HUB.
  //
  // Probed on 2026-10-10: driving this knob to both ends of its domain changes not one MATCH out of
  // 150, because rung 2 of the idle ladder already sends every ROBOT with `carrying < capacity` off to
  // bank, so only a full one (frac = 1.0) ever reaches the rung that reads this number, and 0.5 and 1.0
  // are the same instruction there. The denying that does happen comes from the last rung ("block", at
  // any fill level) and from the macro plan, not from here.
  pressWhenIdleFrac: 0.8083,
  // How many seconds before our HUB goes live a carrying ROBOT stops denying and goes to hold on its
  // own shooting lane. Denying is worth something, but the SHIFT opens with a burst: a ROBOT that is
  // still parked on the opponent's shooter when it does has to drive home empty-handed while its
  // partners dump, and the load it was holding is the one thing that could have scored on the first
  // live tick. 0 turns the rung off, which is the control the value was measured against.
  darkPrepSec: 4,
  // PASS: how full a collector on the far half has to be before it throws its load back to a partner
  // instead of driving it home itself. This is the `auto` posture — the conservative one, and the
  // shipped default for every ROBOT. It is deliberately strict: measured over 24 MATCHES against the
  // greedy baseline, relaxing it (0.6 fill, 90 in margin) did not move the average score but cut the
  // win rate from 25% to 6%, so the AI's plan search cannot yet price a pass correctly and the play
  // stays user-driven. Set a ROBOT to `eager` to use it.
  passWhenFarFrac: 0.85,
  // PASS (eager posture): the load only has to be worth a throw, because an eager ROBOT will aim at
  // its own ALLIANCE ZONE even when no partner is there to catch the FUEL.
  passEagerFrac: 0.34,
  // defence
  defendCarryWeight: 0.4407,
  defendThreatWeight: 0.5,
  // TOWER: how much a TRAVERSAL RP is worth when choosing the END GAME ladder
  climbTraversalFocus: 0.7802,
  // AUTO posture is a per-MATCH plan parameter, not a weight: the planner chooses it by search
  // (searchAuto), so it is deliberately absent from this vector.
  // search
  mctsExploration: 0.8776,
  modelEfficiency: 0.85, // scales the analytic model to the engine's observed output
};

// The evolved vector. modelEfficiency is excluded: it is not a strategy choice but a measurement,
// fitted at load by calibrateModel() against real engine MATCHES, so searching it would just spend
// a dimension on a value the runtime overwrites.
export const WEIGHT_KEYS = Object.keys(DEFAULT_WEIGHTS).filter((k) => k !== 'modelEfficiency');

// Every weight has a domain outside which it stops meaning anything. The evolution has to stay
// inside it, or it can "improve" by pushing a threshold out of reach — e.g. pressWhenIdleFrac
// above 1 is a carrying fraction that can never be met, which silently deletes the behaviour
// instead of tuning it.
export const WEIGHT_BOUNDS = {
  traversalOverhead: [0.5, 4],
  aimOverhead: [0.3, 3],
  // Measured in the engine: one ROBOT sent to shadow an opponent costs its own ALLIANCE about 180
  // points and takes about 20 off the victim, so the search has to be free to conclude "defending
  // does not pay here" instead of being pinned to a positive value it cannot argue with.
  defenseEfficacy: [0, 0.9],
  bankCredit: [0, 0.8],
  clusterDensity: [0.4, 2.0],
  clusterNear: [0.0005, 0.005],
  clusterHubExitPenalty: [0.5, 4],
  clusterOwnHalfBias: [0, 1.2],
  clusterStickiness: [0.1, 1.2],
  targetRefreshSec: [0.2, 2.0],
  mateSeparation: [0, 3],
  dumpThreshold: [0.15, 1.0],
  dumpBeforeIdleFrac: [0.1, 0.8],
  dumpBeforeIdleSec: [1, 8],
  pressWhenIdleFrac: [0.5, 1.0],
  // 8 s looked worth +13 win points at n=96 and lost it at n=192, so 4 stays shipped. The ceiling is
  // 8 because that is as far as the measurement carried before it went the other way.
  darkPrepSec: [0, 8],
  passWhenFarFrac: [0.4, 1.0],
  passEagerFrac: [0.1, 0.9],
  defendCarryWeight: [0.1, 1.5],
  defendThreatWeight: [0.1, 1.5],
  climbTraversalFocus: [0, 3],
  mctsExploration: [0.2, 1.6],
};

export function clampWeights(w) {
  const out = { ...w };
  for (const k of WEIGHT_KEYS) {
    const b = WEIGHT_BOUNDS[k];
    if (!b) continue;
    const v = Number(out[k]);
    out[k] = Number.isFinite(v) ? Math.max(b[0], Math.min(b[1], v)) : DEFAULT_WEIGHTS[k];
  }
  return out;
}

export function cloneWeights(w) {
  return clampWeights({ ...DEFAULT_WEIGHTS, ...w });
}

// The HUMAN PLAYER's own decision (§6.1). It is keyed to the HUB window rather than to a scripted
// feed rate, because the window is what decides the value of a FUEL: an active HUB pays a point for
// a throw (Table 6-4), an inactive one pays nothing, so a throw during a dark window spends FUEL off
// the FIELD for no return at all.
//
//   HUB active   -> throw at it. Measured on the elite mirror, banking the CHUTE this way beats
//                   dumping it: 619 vs 607 MATCH points, and in AI-vs-greedy 52% vs 41% over 96
//                   MATCHES. A scored FUEL is not lost either, it recirculates to the NEUTRAL ZONE
//                   (§5.4).
//   HUB inactive -> dump. The FUEL cannot score now, so it is worth more on the carpet in our own
//                   ALLIANCE ZONE, where a ROBOT reaches it without the trip across the FIELD. Below
//                   four FUEL the door swing costs more than it moves, so the HP holds instead.
//
// Shared by the AI and every baseline on purpose: an AI-vs-baseline number has to isolate the ROBOT
// policy, not quietly also differ in how the two sides use their OUTPOST.
export function humanChoice(obs, side) {
  const pool = obs.pools[side];
  const hp = obs.human[side];
  if (hp.h + pool.chute + pool.corral === 0) return 'HOLD';
  if (obs.hub[side]) return 'SCORE';
  return pool.chute >= 4 ? 'DUMP' : 'HOLD';
}

// How much FUEL a ROBOT should leave queued at the OUTPOST before it stops delivering. The HP throws
// at humanThrowPerSec, so this is roughly what one alliance SHIFT of throwing clears: past it a
// delivery is FUEL parked off the FIELD where no ROBOT can reach it and no HP has time to throw it.
export const OUTPOST_QUEUE_MAX = 12;

// §5.9.2 is what makes this legal at all: the OUTPOST's bottom opening is where "ROBOTs can push FUEL
// into the CORRAL", and the OUTPOST exists so that "ROBOTs can deliver FUEL to their HUMAN PLAYERS".
// The trade is time against FUEL: the CORRAL takes a load the ROBOT is already holding, so handing it
// over costs one detour home and buys the whole window back for sweeping, while the HP converts the
// load in parallel at its own slower rate (§6.1).
//
// Only for a load that cannot score, and only while the queue is short — a full ROBOT with a live HUB
// should be shooting, and the HP cannot clear a backlog. Shared by the AI and the greedy baseline so
// the OUTPOST never becomes a second, hidden difference between the two sides of a comparison.
export function worthDelivering(obs, side, rb) {
  if ((rb.feedMode || 'auto') === 'off') return false;
  if (obs.hub[side]) return false;
  if (rb.carrying < rb.capacity) return false;
  return obs.pools[side].corral < OUTPOST_QUEUE_MAX;
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
      mechanism: p.mechanism,
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
export const ARCH_FEATURES = {
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
  // Dimensions absent from `feat` are ignored rather than treated as zero, so an early-match
  // observation (no AUTO result yet) does not count as evidence of a low AUTO output.
  update(feat, weight = 1) {
    const sd = { score: 0.22, defend: 0.2, climb: 0.2, climbLvl: 0.35, autoFuel: 0.3 };
    const dims = Object.keys(sd).filter((f) => feat[f] !== undefined);
    if (!dims.length) return;
    for (const k of Object.keys(ARCH_FEATURES)) {
      const c = ARCH_FEATURES[k];
      let ll = 0;
      for (const f of dims) {
        const d = (feat[f] - c[f]) / sd[f];
        ll += -0.5 * d * d;
      }
      this.counts[k] += Math.exp(ll / dims.length) * weight;
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
      // A CLIMB role would be inert (see roleCandidates), so an archetype's climb appetite is
      // expressed through climbPriority below rather than through a role slot.
      for (const [k, v] of [
        [ROLE.SCORE, bias.SCORE + bias.CLIMB],
        [ROLE.DEFEND, bias.DEFEND],
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
          // UCB1 needs the MEAN value; `c.value` is a running sum, so using it directly would make
          // every extra visit look like extra quality and starve the siblings.
          const u = c.visits === 0 ? Infinity : c.value / c.visits + this.w.mctsExploration * Math.sqrt(Math.log(node.visits + 1) / c.visits);
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
