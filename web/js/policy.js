// The AI policy object injected into the engine. Layers:
//   onPeriodStart -> MCTS (ai.js) picks this period's roles, the END GAME climb ladder, and the
//                    AUTO posture, all scored by the analytic model against a Bayesian opponent.
//   decide        -> per-ROBOT utility policy that turns roles into engine INTENTs, with explicit
//                    rule-risk handling (G407 shoot gate, G408 HUB-exit avoidance, G419 corridor
//                    isolation, G420 TOWER protection window).

import { TIME, POINTS, FIELD, hubActiveTable } from './rules.js';
import { GEO, INTENT } from './engine.js';
import {
  ROLE,
  periodSeconds,
  makeContext,
  evaluateMatch,
  emptyPlan,
  withRoles,
  withClimb,
  withAuto,
  estimateAlliance,
} from './fastsim.js';
import { DEFAULT_WEIGHTS, MacroPlanner, OpponentModel, scoutCaps } from './ai.js';

const CELL_X = 48;
const CELL_Y = 48;

export function createAI(opts) {
  const {
    side,
    weights = DEFAULT_WEIGHTS,
    caps, // our own (true) capabilities; scouting noise applies to the OPPONENT only
    oppProfiles,
    rngSeed = 12345,
    iterations = 240,
    objective = 'rs',
    event = 'regional',
    towerL1TeleopAllowed = true,
    name = 'AI',
    planOverride = null, // ablate the search: use this plan verbatim (debug/benchmark only)
  } = opts;

  const rng = makeRngLocal(rngSeed);
  const oppCaps = scoutCaps(oppProfiles, rng, 0.12);
  const ourCaps = caps;
  const oppSide = side === 'red' ? 'blue' : 'red';

  const oppModel = new OpponentModel(oppSide);
  let basePlan = emptyPlan();
  let currentPlan = emptyPlan();
  let planner = null;
  let schedule = null;
  let climbOpt = null;
  let climbLanes = {};
  const targets = new Map();
  // Once a ROBOT commits to a scoring run it must empty its hopper: re-testing the dump threshold
  // every decision makes it fire one FUEL, drop below the threshold, and drive back out forever.
  const scoreCommit = new Map();
  let claims = {};
  let lastDecisionT = -1;
  const oppHistory = { fuel: 0, tower: 0, lastFuel: 0, lastT: 0 };
  let mctsStats = { rollouts: 0, calls: 0, nodes: 0 };

  const ctxWith = (sched) =>
    makeContext({
      schedule: sched,
      caps: side === 'red' ? { red: ourCaps, blue: oppCaps } : { red: oppCaps, blue: ourCaps },
      event,
      objective,
      weights,
    });

  function capSummary(obs, who) {
    const list = obs.robots.filter((r) => r.alliance === who);
    let attach = 0;
    let total = 0;
    let levels = 0;
    for (const r of list) {
      if (r.climb.done || r.climb.progress > 0 || r.climb.attaching) attach += 1;
      total += 1;
      levels += r.climb.level + r.climb.autoLevel;
    }
    return { attach: attach / Math.max(1, total), levels: levels / 9 };
  }

  // Defence presence: share of the opponent's ROBOTs currently within bumper range of ours.
  function defenseShare(obs) {
    const ours = obs.robots.filter((r) => r.alliance === side);
    const theirs = obs.robots.filter((r) => r.alliance === oppSide);
    let engaged = 0;
    for (const o of theirs) {
      for (const m of ours) {
        if (Math.hypot(o.x - m.x, o.y - m.y) < 34) {
          engaged += 1;
          break;
        }
      }
    }
    return engaged / Math.max(1, theirs.length);
  }

  function observe(obs) {
    const c = capSummary(obs, oppSide);
    const ourScore = obs.score[side].fuel + obs.score[side].towerAuto + obs.score[side].towerTeleop;
    const oppScore = obs.score[oppSide].fuel + obs.score[oppSide].towerAuto + obs.score[oppSide].towerTeleop;
    oppModel.update({
      score: oppScore + ourScore > 4 ? oppScore / (oppScore + ourScore) : 0.6,
      defend: defenseShare(obs),
      climb: c.attach,
      climbLvl: c.levels,
      autoFuel: Math.min(1, obs.autoFuel[oppSide] / 40),
    });
  }

  // ---- defensive target selection: deny their highest-value scorer, skip TOWER-adjacent
  // contacts in the G420 window, and never defend when their HUB cannot score anyway.
  function pickDefenseTarget(rb, obs) {
    const t = obs.t;
    if (t > TIME.matchSec - TIME.endgameSec) {
      // G420: no contact with an opponent touching its TOWER in the last 30 s.
      const cands = obs.robots.filter(
        (o) =>
          o.alliance === oppSide &&
          Math.hypot(o.x - GEO[oppSide].tower.x, o.y - GEO[oppSide].tower.y) > 110,
      );
      if (!cands.length) return -1;
    }
    let best = -1;
    let bestV = -Infinity;
    for (const o of obs.robots) {
      if (o.alliance !== oppSide || o.disabled) continue;
      const d = Math.hypot(o.x - rb.x, o.y - rb.y);
      const capIdx = o.slot;
      const scouted = oppCaps[capIdx] || { speed: 120, intake: 2.5 };
      const threat = o.carrying * weights.defendCarryWeight + (scouted.speed * scouted.intake) / 400 * weights.defendThreatWeight;
      const v = threat - d / 900;
      if (v > bestV) {
        bestV = v;
        best = o.idx;
      }
    }
    return best;
  }

  // ---- FUEL cluster targeting. The density grid is recomputed per decision round; cells inside a
  // HUB exit zone carry a G408 penalty, cells already claimed by a partner are skipped, and the
  // BUMP/TRENCH band is avoided when a partner is already blocking a corridor (G419).
  // ---- FUEL targeting. Candidates are scored by estimated cycle rate (FUEL per second of ROBOT
  // time including the return trip to the HUB), which is the quantity that actually wins MATCHES.
  // The globally nearest pile is always one of the candidates, so this can never do worse than a
  // pure greedy policy - it only adds choices.
  function pickCluster(rb, obs) {
    const g = GEO[side];
    const cols = Math.ceil(GEO.L / CELL_X);
    const rows = Math.ceil(GEO.W / CELL_Y);
    const counts = new Float32Array(cols * rows);
    const buckets = new Map();
    const st = obs.fuel.state;
    const fx = obs.fuel.x;
    const fy = obs.fuel.y;
    let nearestIdx = -1;
    let nearestD = Infinity;
    for (let i = 0; i < obs.fuel.total; i++) {
      if (st[i] !== 0) continue;
      const dx = fx[i] - rb.x;
      const dy = fy[i] - rb.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < nearestD) {
        nearestD = d2;
        nearestIdx = i;
      }
      const cx = Math.min(cols - 1, Math.floor(fx[i] / CELL_X));
      const cy = Math.min(rows - 1, Math.floor(fy[i] / CELL_Y));
      const key = cx * rows + cy;
      counts[key] += 1;
      const b = buckets.get(key);
      if (b) b.push(i);
      else buckets.set(key, [i]);
    }
    const remaining = Math.max(1, rb.capacity - rb.carrying);
    const speed = Math.max(40, rb.driveSpeedIps);
    const intake = Math.max(0.5, rb.intakeRate);
    const shootRate = Math.max(0.5, rb.shootRate);
    const inBandCount = obs.robots.filter(
      (r) => r.alliance === side && !r.disabled && r.x >= g.band[0] - 12 && r.x <= g.band[1] + 12,
    ).length;

    const cycleRate = (n, dist) => {
      const take = Math.min(n, remaining);
      const sec = (2 * dist) / speed + take / intake + take / shootRate + 1.0;
      return take / sec;
    };
    const penaltyAt = (px, py) => {
      let pen = 0;
      for (const s of ['red', 'blue']) {
        const h = GEO[s].hub;
        const ex = h.x + (s === 'red' ? FIELD.hub.sizeIn / 2 : -FIELD.hub.sizeIn / 2);
        if (Math.hypot(px - ex, py - h.y) < GEO.hubExitZoneRadiusIn) pen += weights.clusterHubExitPenalty;
      }
      const cellInBand = px >= g.band[0] - 12 && px <= g.band[1] + 12;
      if (cellInBand && inBandCount >= 1) pen += 4; // G419: do not stack into the corridor band
      return pen;
    };

    const prev = targets.get(rb.slot);
    const stickyKey = prev && obs.t - prev.t < weights.targetRefreshSec ? prev.key : -1;

    let best = null;
    const consider = (x, y, key, n) => {
      const dist = Math.hypot(x - rb.x, y - rb.y);
      let v = cycleRate(n, dist) * weights.clusterDensity - dist * weights.clusterNear * 0.1;
      v -= penaltyAt(x, y);
      const distToHome = side === 'red' ? x : GEO.L - x;
      v -= (distToHome / GEO.L) * weights.clusterOwnHalfBias;
      if (key >= 0 && key === stickyKey) v += weights.clusterStickiness;
      if (!best || v > best.v) best = { v, x, y, key, n };
    };

    // candidate 1: the single nearest free FUEL (what a simple greedy policy does)
    if (nearestIdx >= 0) consider(fx[nearestIdx], fy[nearestIdx], -1, 1);
    // candidate 2..n: each cell's nearest FUEL, scored as a pile
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        const key = cx * rows + cy;
        const n = counts[key];
        if (n < 1) continue;
        if (claims[key] && key !== stickyKey) continue;
        const list = buckets.get(key);
        let bx = (cx + 0.5) * CELL_X;
        let by = (cy + 0.5) * CELL_Y;
        let bd = Infinity;
        for (const i of list) {
          const d = (fx[i] - rb.x) ** 2 + (fy[i] - rb.y) ** 2;
          if (d < bd) {
            bd = d;
            bx = fx[i];
            by = fy[i];
          }
        }
        consider(bx, by, key, n);
      }
    }
    if (!best) return null;
    if (best.key >= 0) claims[best.key] = true;
    targets.set(rb.slot, { key: best.key, t: obs.t });
    return { x: best.x, y: best.y, weight: best.n };
  }

  function secsUntilHubOff(obs) {
    const sched = obs.schedule;
    if (!sched) return null;
    const now = obs.hub[side];
    if (!now) return null;
    let acc = 0;
    let t = obs.t;
    // walk the remaining periods using the FMS-relayed order (§6.4.1)
    for (const row of sched) {
      const [start, end] = periodBounds(row.period);
      if (end <= t) continue;
      const active = row[side];
      const dur = Math.min(end, TIME.matchSec) - Math.max(start, t);
      if (dur <= 0) continue;
      if (active) acc += dur;
      else return acc;
      t = Math.max(t, end);
    }
    return acc;
  }

  function periodBounds(period) {
    const a = TIME.autoSec;
    const tr = a + TIME.transitionSec;
    switch (period) {
      case 'AUTO':
        return [0, a];
      case 'TRANSITION':
        return [a, tr];
      case 'END GAME':
        return [tr + TIME.shiftSec * 4, TIME.matchSec];
      default: {
        const i = Number(String(period).split(' ')[1]) - 1;
        return [tr + i * TIME.shiftSec, tr + (i + 1) * TIME.shiftSec];
      }
    }
  }

  function planAuto(obs) {
    planner = new MacroPlanner(ctxWith(hubActiveTable('red')), oppModel, weights);
    planner.side = side;
    // The HUB order for the ALLIANCE SHIFTS is not known until the AUTO result, and the AUTO fuel
    // target influences which way that goes, so evaluate each candidate under both branches.
    let best = null;
    const trialSched = hubActiveTable(side);
    for (const fuelTarget of [0.25, 0.5, 0.75, 1.0]) {
      for (let autoClimb = 0; autoClimb <= 2; autoClimb++) {
        let sum = 0;
        const n = 10;
        for (let i = 0; i < n; i++) {
          const cand = withAuto(basePlan, { fuelTarget, climbCount: autoClimb });
          const oppPlan = oppModel.samplePlan(null, rng, trialSched);
          const ctxA = ctxWith(trialSched);
          const ours = estimateAlliance(ctxA, side, withAuto(cand, { fuelTarget, climbCount: autoClimb }), oppPlan, towerL1TeleopAllowed);
          const theirs = estimateAlliance(ctxA, oppSide, oppPlan, cand, towerL1TeleopAllowed);
          const winner = ours.fuel >= theirs.fuel ? side : oppSide;
          const sched = hubActiveTable(winner);
          const ctx = ctxWith(sched);
          const res = evaluateMatch(ctx, side, cand, oppPlan, { spread: 0.18, towerL1TeleopAllowed });
          sum += res.utility;
        }
        const v = sum / n;
        if (!best || v > best.value) best = { value: v, auto: { fuelTarget, climbCount: autoClimb } };
      }
    }
    basePlan = withAuto(basePlan, best.auto);
    currentPlan = basePlan;
    mctsStats.calls += 1;
    mctsStats.rollouts += 80;
  }

  function planPeriod(period, obs) {
    if (!schedule) schedule = obs.schedule ? obs.schedule.map((r) => ({ ...r })) : null;
    if (!schedule) return;
    const ctx = ctxWith(schedule);
    planner = new MacroPlanner(ctx, oppModel, weights);
    const idx = schedule.findIndex((r) => r.period === period);
    if (idx < 0) return;
    if (period === 'END GAME') {
      const r = planner.searchEndgame(side, schedule, basePlan, idx, 26, (rng() * 1e6) | 0, towerL1TeleopAllowed);
      climbOpt = r.climb;
      basePlan = withClimb(withRoles(basePlan, 'END GAME', currentPlan.periods['END GAME']), climbOpt);
      // Assign TOWER lanes to the best climbers; one ROBOT per lane keeps partners from
      // supporting each other (G414).
      const order = obs.robots
        .filter((r) => r.alliance === side)
        .slice()
        .sort((a, b) => b.derived.maxClimbLevel - a.derived.maxClimbLevel || a.climb.timeSec - b.climb.timeSec);
      climbLanes = {};
      for (let k = 0; k < Math.min(climbOpt.count, order.length); k++) {
        climbLanes[order[k].slot] = climbOpt.levels[k] || 3;
      }
      mctsStats.calls += 1;
      mctsStats.rollouts += r.totalRollouts;
      currentPlan = basePlan;
      return;
    }
    const r = planner.search(side, schedule, basePlan, idx, iterations, (rng() * 1e6) | 0);
    basePlan = withRoles(basePlan, period, r.action);
    currentPlan = basePlan;
    mctsStats.calls += 1;
    mctsStats.rollouts += r.totalRollouts;
  }

  return {
    name,
    side,
    debug: opts.debug ? [] : null,
    stats: () => ({ ...mctsStats, weights }),
    planSnapshot: () => JSON.parse(JSON.stringify({ plan: currentPlan, climbLanes, posterior: oppModel.posterior() })),

    reset() {
      basePlan = emptyPlan();
      currentPlan = emptyPlan();
      schedule = null;
      climbOpt = null;
      climbLanes = {};
      targets.clear();
      scoreCommit.clear();
      claims = {};
      mctsStats = { rollouts: 0, calls: 0, nodes: 0 };
      lastDecisionT = -1;
    },

    onPeriodStart(period, obs) {
      observe(obs);
      if (planOverride) {
        const base = emptyPlan();
        for (const k of Object.keys(base.periods)) if (planOverride.periods && planOverride.periods[k]) base.periods[k] = planOverride.periods[k].slice();
        if (planOverride.auto) base.auto = { ...base.auto, ...planOverride.auto };
        if (planOverride.climb) base.climb = { ...base.climb, ...planOverride.climb };
        basePlan = base;
        currentPlan = base;
        if (planOverride.climb) {
          climbOpt = base.climb;
          climbLanes = {};
          const order = obs.robots
            .filter((r) => r.alliance === side)
            .slice()
            .sort((a, b) => b.derived.maxClimbLevel - a.derived.maxClimbLevel || a.climb.timeSec - b.climb.timeSec);
          for (let k = 0; k < Math.min(base.climb.count, order.length); k++) climbLanes[order[k].slot] = base.climb.levels[k] || 3;
        }
        return;
      }
      if (period === 'AUTO') planAuto(obs);
      else planPeriod(period, obs);
    },

    decide(rb, obs) {
      const t = obs.t;
      const period = obs.period;
      if (lastDecisionT !== t) {
        lastDecisionT = t;
        claims = {};
      }
      const g = GEO[side];
      const roles = (currentPlan.periods[period] || [ROLE.SCORE, ROLE.SCORE, ROLE.SCORE]).slice();
      let role = roles[rb.slot] || ROLE.SCORE;
      const why = { reason: 'fallthrough' };
      const ret = (intent) => {
        if (this.debug && this.debug.length < 40000) {
          this.debug.push({
            t: +t.toFixed(2),
            slot: rb.slot,
            mode: intent.mode,
            reason: why.reason,
            tx: intent.target ? Math.round(intent.target.x) : intent.targetRobot != undefined ? 'R' + intent.targetRobot : '',
            ty: intent.target ? Math.round(intent.target.y) : '',
            c: rb.carrying,
            x: Math.round(rb.x),
            y: Math.round(rb.y),
            hub: obs.hub[side] ? 1 : 0,
          });
        }
        return intent;
      };

      if (climbLanes[rb.slot] !== undefined && climbOpt && t >= climbOpt.startAt && rb.derived.maxClimbLevel >= 1) {
        if (!rb.climb.done) {
          why.reason = 'endgame-lane';
          return ret({ mode: INTENT.CLIMB, level: Math.min(climbLanes[rb.slot], rb.derived.maxClimbLevel) });
        }
      }
      if (period === 'AUTO') {
        if (rb.slot < currentPlan.auto.climbCount && rb.derived.maxClimbLevel >= 1 && !rb.climb.done) {
          why.reason = 'auto-climb';
          return ret({ mode: INTENT.CLIMB, level: 1 });
        }
        if (rb.carrying > 0) {
          why.reason = 'auto-score';
          return ret({ mode: INTENT.SCORE });
        }
        const c0 = pickCluster(rb, obs);
        why.reason = 'auto-collect';
        return ret(c0 ? { mode: INTENT.COLLECT, target: c0 } : { mode: INTENT.STOCKPILE, target: g.shoot });
      }

      const hubActive = obs.hub[side];
      const oppActive = obs.hub[oppSide];

      if (role === ROLE.DEFEND) {
        if (!oppActive) role = ROLE.SCORE;
        else {
          const tgt = pickDefenseTarget(rb, obs);
          if (tgt >= 0) {
            why.reason = 'defend';
            return ret({ mode: INTENT.DEFEND, targetRobot: tgt });
          }
          role = ROLE.SCORE;
        }
      }

      const frac = rb.carrying / Math.max(1, rb.capacity);
      if (scoreCommit.get(rb.slot) && (!hubActive || rb.carrying === 0)) scoreCommit.set(rb.slot, false);
      if (scoreCommit.get(rb.slot)) {
        why.reason = 'dump-committed';
        return ret({ mode: INTENT.SCORE });
      }
      if (hubActive && rb.carrying > 0) {
        const left = secsUntilHubOff(obs);
        const start = (reason) => {
          scoreCommit.set(rb.slot, true);
          why.reason = reason;
          return ret({ mode: INTENT.SCORE });
        };
        if (frac >= weights.dumpThreshold) return start(`dump-full(${left === null ? 'n/a' : left.toFixed(1)}s)`);
        if (left !== null && left <= weights.dumpBeforeIdleSec && frac >= weights.dumpBeforeIdleFrac) {
          return start(`dump-window(${left.toFixed(1)}s)`);
        }
        if (t > TIME.matchSec - 3) return start('dump-last3s');
      }
      if (!hubActive && frac >= weights.idleStockpileFrac) {
        why.reason = 'idle-stockpile';
        return ret({ mode: INTENT.STOCKPILE, target: g.shoot });
      }
      const cell = pickCluster(rb, obs);
      why.reason = 'collect';
      return ret(cell ? { mode: INTENT.COLLECT, target: { x: cell.x, y: cell.y } } : { mode: INTENT.STOCKPILE, target: g.shoot });
    },
  };
}

function makeRngLocal(seed) {  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.gauss = (mean = 0, sd = 1) => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  rng.chance = (p) => rng() < p;
  rng.int = (n) => Math.floor(rng() * n);
  rng.range = (a2, b) => a2 + rng() * (b - a2);
  return rng;
}

