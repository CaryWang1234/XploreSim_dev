// The AI policy object injected into the engine. Layers:
//   onPeriodStart -> MCTS (ai.js) picks this period's roles, the END GAME climb ladder, and the
//                    AUTO posture, all scored by the analytic model against a Bayesian opponent.
//   decide        -> per-ROBOT utility policy that turns roles into engine INTENTs, with explicit
//                    rule-risk handling (G407 shoot gate, G408 HUB-exit avoidance, G419 corridor
//                    isolation, G420 TOWER protection window).

import { TIME, POINTS, FIELD, hubActiveTable } from './rules.js';
import { GEO, INTENT, segmentPointDistance, SHOT_BLOCK_RADIUS_IN } from './engine.js';
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
import { DEFAULT_WEIGHTS, MacroPlanner, OpponentModel, ARCH_FEATURES, scoutCaps, humanChoice, worthDelivering } from './ai.js';

const CELL_X = 48;
const CELL_Y = 48;
const OBSERVE_EVERY_SEC = 10;
// Inside this a partner is close enough that two ROBOTs are working one pile and bumping bumpers
// doing it. Roughly two car widths: the separation penalty falls off to nothing at the edge, so it
// spreads the ALLIANCE out without forbidding two ROBOTs from ever being near each other.
const MATE_SEP_IN = 72;

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
  let defClaims = {};
  // Roles the plan assigned that could not be executed on the previous decision round: a DEFEND slot
  // with no opponent to shadow, a SCORE slot with no pile in reach. This is the cheapest honest signal
  // that the plan is wrong, and it is free — it is collected from the targets the micro policy had to
  // give up on anyway, not from a second search.
  let stuck = new Set();
  let lastStuck = new Set();
  let lastDecisionT = -1;
  let lastObserveT = -Infinity;
  // A SHIFT is 25 s of commitment and the world does not hold still for it: a ROBOT gets disabled, the
  // midfield runs dry, the opponent's plan changes. The macro search used to run only at period start —
  // seven looks a MATCH — so a plan made against a three-ROBOT opponent kept assigning roles to a machine
  // that had already stopped moving. Re-search when the state CLASS changes, not when it drifts: the
  // signature below is deliberately coarse (who is disabled, and whether there is FUEL to collect at
  // all), with a cooldown so a borderline case cannot re-plan every round. The cost is that a role can
  // change under a ROBOT mid-window; the latches in `scoreCommit` and the corridor commit are what keep
  // that from interrupting a dump or a climb already in progress.
  let lastReplanSig = '';
  let lastReplanT = -Infinity;
  const REPLAN_COOLDOWN_SEC = 6;
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
    const feat = {
      score: oppScore + ourScore > 4 ? oppScore / (oppScore + ourScore) : 0.6,
      defend: defenseShare(obs),
      climb: c.attach,
      climbLvl: c.levels,
    };
    // AUTO FUEL only exists once AUTO has closed, so it is not evidence during AUTO itself.
    if (obs.t >= TIME.autoSec) feat.autoFuel = Math.min(1, obs.autoFuel[oppSide] / 40);
    oppModel.update(feat);
  }

  // ---- defensive target selection: deny their highest-value scorer, skip TOWER-adjacent
  // contacts in the G420 window, and never defend when their HUB cannot score anyway.
  function pickDefenseTarget(rb, obs) {
    const t = obs.t;
    const endgame = t > TIME.matchSec - TIME.endgameSec;
    let best = -1;
    let bestV = -Infinity;
    let fallback = -1;
    let fallbackV = -Infinity;
    for (const o of obs.robots) {
      if (o.alliance !== oppSide || o.disabled) continue;
      // G420: no contact with an opponent touching its TOWER in the last 30 s.
      if (endgame && Math.hypot(o.x - GEO[oppSide].tower.x, o.y - GEO[oppSide].tower.y) <= 110) continue;
      const d = Math.hypot(o.x - rb.x, o.y - rb.y);
      const capIdx = o.slot;
      const scouted = oppCaps[capIdx] || { speed: 120, intake: 2.5 };
      const threat = o.carrying * weights.defendCarryWeight + (scouted.speed * scouted.intake) / 400 * weights.defendThreatWeight;
      const v = threat - d / 900;
      if (v > fallbackV) {
        fallbackV = v;
        fallback = o.idx;
      }
      // Nobody gains from two ROBOTs shadowing the same opponent ROBOT: they bump each other off it
      // and leave a third opponent free. A partner that got there first keeps it; this ROBOT only
      // doubles up when there is no other opponent to take.
      if (defClaims[o.idx]) continue;
      if (v > bestV) {
        bestV = v;
        best = o.idx;
      }
    }
    const chosen = best >= 0 ? best : fallback;
    if (chosen >= 0) defClaims[chosen] = true;
    return chosen;
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

    // Partners, and where each of them was last sent. Two ROBOTs converging on one pile do not empty it
    // any faster and spend the trip shoving each other, so a candidate is priced down by how close it
    // is to a partner — both the partner's body and the target it is already driving at, because a
    // partner 200 in from a pile is still going to arrive there before this ROBOT crosses the field.
    const mates = [];
    if (weights.mateSeparation > 0) {
      for (const m of obs.robots) {
        if (m.alliance !== side || m.disabled || m.idx === rb.idx) continue;
        mates.push({ x: m.x, y: m.y });
        const mt = targets.get(m.slot);
        if (mt && mt.point) mates.push({ x: mt.point.x, y: mt.point.y });
      }
    }

    let best = null;
    const consider = (x, y, key, n) => {
      const dist = Math.hypot(x - rb.x, y - rb.y);
      let v = cycleRate(n, dist) * weights.clusterDensity - dist * weights.clusterNear * 0.1;
      v -= penaltyAt(x, y);
      const distToHome = Math.abs(x - GEO[side].hub.x);
      v -= (distToHome / GEO.L) * weights.clusterOwnHalfBias;
      if (mates.length) {
        for (const m of mates) {
          const d = Math.hypot(x - m.x, y - m.y);
          if (d < MATE_SEP_IN) v -= weights.mateSeparation * (1 - d / MATE_SEP_IN);
        }
      }
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
    targets.set(rb.slot, { key: best.key, t: obs.t, point: { x: best.x, y: best.y } });
    return { x: best.x, y: best.y, weight: best.n };
  }

  // ---- firing point selection. A full-width shooter can only score from the HUB face, so it gets
  // no choice. A turret tracks the HUB and may fire from anywhere inside its ALLIANCE ZONE (G407),
  // which is also its answer to defence: if an opponent is already in its face it moves to the spot
  // in the zone that is furthest from them instead of contesting the one place a defender waits.
  function opponentClearance(x, y, obs) {
    let near = Infinity;
    for (const o of obs.robots) {
      if (o.alliance !== oppSide || o.disabled) continue;
      const d = Math.hypot(o.x - x, o.y - y);
      if (d < near) near = d;
    }
    return near;
  }

  // Room to shoot, measured against EVERY other ROBOT rather than only the opponents. Two turrets
  // ranked by opponent clearance alone pick the same candidate and then shove each other off it.
  function nearestRobotClearance(x, y, self, obs) {
    let near = Infinity;
    for (const o of obs.robots) {
      if (o.disabled || o.idx === self.idx) continue;
      const d = Math.hypot(o.x - x, o.y - y);
      if (d < near) near = d;
    }
    return near;
  }

  function turretFireSpot(rb, obs) {
    const g = GEO[side];
    const baseX = g.shoot.x;
    const baseY = g.shoot.y;
    const back = side === 'red' ? -1 : 1; // deeper into our own zone, away from the HUB face
    const cands = [
      { x: baseX, y: baseY },
      { x: baseX, y: baseY - 55 },
      { x: baseX, y: baseY + 55 },
      { x: baseX + back * 35, y: baseY },
      { x: baseX + back * 35, y: baseY - 55 },
      { x: baseX + back * 35, y: baseY + 55 },
      { x: baseX + back * 70, y: baseY },
    ];
    let best = { x: baseX, y: baseY };
    let bestClearance = -Infinity;
    for (const c of cands) {
      if (c.x < g.allianceZone[0] + 12 || c.x > g.allianceZone[1] - 12) continue;
      if (c.y < 24 || c.y > GEO.W - 24) continue;
      const near = nearestRobotClearance(c.x, c.y, rb, obs);
      if (near > bestClearance) {
        bestClearance = near;
        best = { x: c.x, y: c.y };
      }
    }
    return best;
  }

  // Distance below which an opponent is close enough to actually be in the way of a shot.
  const DEFENDED_CLEARANCE = 40;

  // ---- PASS targeting. A collector that has crossed the CENTER LINE faces a long trip home; if a
  // partner is already back on our side, throwing the load to them converts that trip into the
  // partner's short one. Passing to somebody standing next to you moves nothing, so the target is
  // always a partner who is on our own half and has room to take the load. With `allowZone` (the
  // eager posture) a ROBOT with nobody to throw to aims at its own ALLIANCE ZONE instead: the load
  // becomes loose FUEL on the half we are about to fight for, which is the play the user asked for.
  function passTarget(rb, obs, allowZone) {
    const onFarSide = side === 'red' ? rb.x > GEO.centerLineX : rb.x < GEO.centerLineX;
    if (!onFarSide) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const m of obs.robots) {
      if (m.alliance !== side || m.disabled || m.idx === rb.idx) continue;
      const onOurHalf = side === 'red' ? m.x < GEO.centerLineX : m.x > GEO.centerLineX;
      if (!onOurHalf) continue;
      const room = m.capacity - m.carrying;
      if (room <= 0) continue;
      // Nearest partner with room wins: a shorter pass lands tighter (the engine spreads the landing
      // with the length of the pass) and leaves the partner closer to the HUB.
      const v = room * 0.5 - Math.hypot(m.x - rb.x, m.y - rb.y);
      if (v > bestScore) {
        bestScore = v;
        best = { x: m.x, y: m.y };
      }
    }
    if (best || !allowZone) return best;
    // Nobody is home to take it, so aim at our own ALLIANCE ZONE: deep enough to be clear of the HUB
    // mouth (a pass can never be a disguised scoring shot) and clear of the HUB-exit zone, because a
    // pile that lands inside it invites a G408 foul the moment somebody collects it.
    const dirHome = side === 'red' ? -1 : 1;
    return {
      x: GEO[side].hub.x + dirHome * (FIELD.hub.sizeIn / 2 + GEO.hubExitZoneRadiusIn + 10),
      y: GEO.yc,
    };
  }

  // ---- Active pushing. The engine's passive shove only rearranges FUEL a ROBOT already ran into;
  // an active pusher goes looking for a pile that is still on THEIR side of the CENTER LINE and herds
  // it home. The target handed over is the FUEL itself — INTENT.PUSH works out the approach so the
  // shove travels toward our half (a BUMPER running into a ball from the home side would send it the
  // wrong way). Only FUEL within reach of the CENTER LINE is worth the trip: past that the round trip
  // costs more than the herd gains.
  function pushTarget(rb, obs) {
    const st = obs.fuel.state;
    let best = null;
    let bestScore = Infinity;
    for (let i = 0; i < obs.fuel.total; i++) {
      if (st[i] !== 0) continue;
      const x = obs.fuel.x[i];
      const y = obs.fuel.y[i];
      const far = side === 'red' ? x > GEO.centerLineX : x < GEO.centerLineX;
      if (!far) continue;
      const fromLine = Math.abs(x - GEO.centerLineX);
      if (fromLine > 140) continue;
      const score = Math.hypot(x - rb.x, y - rb.y) + 2 * fromLine;
      if (score < bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
    return best;
  }

  // How clear the launch lane is: the closest an opponent ROBOT comes to the segment from the firing
  // spot to the HUB. Same geometry the engine uses to decide whether a shot is blocked, so the AI
  // cannot think a lane is clear when the engine will stop the FUEL in it.
  function laneClearance(x, y, obs) {
    const hub = GEO[side].hub;
    let near = Infinity;
    for (const o of obs.robots) {
      if (o.alliance !== oppSide || o.disabled) continue;
      // A ROBOT on the TOWER is above the lane, not in it.
      if (o.climb.attaching || o.climb.progress > 0 || o.climb.done) continue;
      const d = segmentPointDistance(x, y, hub.x, hub.y, o.x, o.y);
      if (d < near) near = d;
    }
    return near;
  }

  // The alignment circle a full-width shooter has to fire from is the engine's, not a guess.
  const ALIGN_RADIUS_IN = 46;
  // Above this the lane counts as clear and the ROBOT stays put: a clear lane is the shortest cycle,
  // and only hunting for an alternative when the shot would actually hit somebody keeps the pick from
  // flapping between equally good spots. Hysteresis over the engine's block radius, because a shot
  // that is blocked at release wastes the FUEL and the trip.
  const BLOCKED_LANE_IN = SHOT_BLOCK_RADIUS_IN + 8;

  function dumperFireSpot(rb, obs) {
    const g = GEO[side];
    const lane = g.shootStations[rb.slot];
    if (laneClearance(lane.x, lane.y, obs) > BLOCKED_LANE_IN) return null;
    const back = side === 'red' ? -1 : 1; // deeper into our own ALLIANCE ZONE, away from the HUB face
    let best = null;
    let bestClear = -Infinity;
    for (const dx of [0, 18, 36]) {
      for (const dy of [-30, -15, 0, 15, 30]) {
        const x = lane.x + back * dx;
        const y = lane.y + dy;
        if (x < g.allianceZone[0] + 10 || x > g.allianceZone[1] - 10) continue;
        if (y < 20 || y > GEO.W - 20) continue;
        if (Math.hypot(x - g.shoot.x, y - g.shoot.y) >= ALIGN_RADIUS_IN) continue;
        const clear = laneClearance(x, y, obs);
        if (clear > bestClear) {
          bestClear = clear;
          best = { x, y };
        }
      }
    }
    return best;
  }

  function scoreIntent(rb, obs) {
    if (rb.mechanism !== 'turret') {
      // Defence can now stop a shot with a body instead of only slowing it down, so a Dumper has to
      // answer it: when its lane is occupied it slides along the HUB face to a spot with a clear line
      // rather than feeding a defender. A clear lane returns null, which drives the old behaviour
      // (the engine's per-DRIVER-STATION lane).
      const spot = dumperFireSpot(rb, obs);
      return spot ? { mode: INTENT.SCORE, target: spot } : { mode: INTENT.SCORE };
    }
    const g = GEO[side];
    const inZone = rb.x >= g.allianceZone[0] && rb.x <= g.allianceZone[1];
    // The whole point of a turret is that it does not need the HUB face. Making it drive to the
    // common shoot point anyway costs a full extra leg per cycle and throws away the mechanism's
    // advantage, so it fires from where it stands whenever that is legal (G407: BUMPERS inside the
    // ALLIANCE ZONE) and clear. It only relocates when it is outside the zone or actually defended.
    if (inZone && opponentClearance(rb.x, rb.y, obs) > DEFENDED_CLEARANCE) {
      return { mode: INTENT.SCORE, target: { x: rb.x, y: rb.y } };
    }
    return { mode: INTENT.SCORE, target: turretFireSpot(rb, obs) };
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

  // The mirror of secsUntilHubOff: how much longer our own HUB stays dark. Null when the schedule is
  // not known yet (AUTO decides it) or when the HUB is already live, and callers read null as "there
  // is no window to prepare for".
  function secsUntilHubOn(obs) {
    const sched = obs.schedule;
    if (!sched || obs.hub[side]) return null;
    let acc = 0;
    let t = obs.t;
    for (const row of sched) {
      const [start, end] = periodBounds(row.period);
      if (end <= t) continue;
      const dur = Math.min(end, TIME.matchSec) - Math.max(start, t);
      if (dur <= 0) continue;
      if (row[side]) return acc;
      acc += dur;
      t = Math.max(t, end);
    }
    return null;
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
      // The search prices a ladder, not whether any ROBOT can actually climb it. On this season's
      // top-tier ROBOTs most cannot, so cap the ladder at the real number of climbers and drop the
      // rest of the plan; otherwise three non-climbers would all leave the FUEL cycle for nothing.
      const climbers = obs.robots
        .filter((x) => x.alliance === side && x.derived.maxClimbLevel >= 1)
        .sort((a, b) => b.derived.maxClimbLevel - a.derived.maxClimbLevel || a.climb.timeSec - b.climb.timeSec);
      const count = Math.min(r.climb.count, climbers.length);
      climbOpt = { count, levels: count ? r.climb.levels.slice(0, count) : [], startAt: r.climb.startAt };
      basePlan = withClimb(withRoles(basePlan, 'END GAME', currentPlan.periods['END GAME']), climbOpt);
      // One ROBOT per lane: partners on the same UPRIGHT would be supporting each other (G414).
      climbLanes = {};
      for (let k = 0; k < count; k++) climbLanes[climbers[k].slot] = climbOpt.levels[k] || 3;
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

  // The coarse state class the re-plan trigger compares on. Everything in it is a fact the plan was made
  // against and cannot re-derive from the clock: which ROBOTs are still moving, whether there is any
  // FUEL left to cycle at all, whether the assigned roles are still executable, and — the part a driver
  // actually re-reads mid-SHIFT — what the opponent model now believes it is looking at. The opponent
  // terms are the POSTERIOR, not the raw observation: `defenseShare(obs)` swings by deciseconds and
  // would have the search re-plan every round on noise, while the archetype-weighted expectation only
  // moves when the evidence has moved.
  function stateSig(obs, stuckNow) {
    let down = 0;
    let oppDown = 0;
    for (const r of obs.robots) {
      if (!r.disabled) continue;
      if (r.alliance === side) down += 1;
      else oppDown += 1;
    }
    const st = obs.fuel && obs.fuel.state;
    let loose = 0;
    if (st) for (let i = 0; i < obs.fuel.total; i++) if (st[i] === 0) loose += 1;
    const post = oppModel.posterior();
    let top = '';
    let bestP = -1;
    let defend = 0;
    for (const [k, p] of Object.entries(post)) {
      if (p > bestP) { bestP = p; top = k; }
      const f = ARCH_FEATURES[k];
      if (f) defend += p * f.defend;
    }
    return `${obs.period}|${down}|${oppDown}|${loose === 0 ? 'dry' : loose < 60 ? 'thin' : 'wet'}|${stuckNow ? stuckNow.size : 0}|${top}|${Math.round(defend * 8)}`;
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
      defClaims = {};
      stuck = new Set();
      lastStuck = new Set();
      mctsStats = { rollouts: 0, calls: 0, nodes: 0 };
      lastDecisionT = -1;
      lastObserveT = -Infinity;
      lastReplanSig = '';
      lastReplanT = -Infinity;
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
            .filter((r) => r.alliance === side && r.derived.maxClimbLevel >= 1)
            .sort((a, b) => b.derived.maxClimbLevel - a.derived.maxClimbLevel || a.climb.timeSec - b.climb.timeSec);
          for (let k = 0; k < Math.min(base.climb.count, order.length); k++) climbLanes[order[k].slot] = base.climb.levels[k] || 3;
        }
        return;
      }
      if (period === 'AUTO') planAuto(obs);
      else planPeriod(period, obs);
      // The plan just made IS the current state class: remember it with a clean slate, or the next
      // decision round would read a "change" that is only the plan being fresh.
      stuck = new Set();
      lastStuck = new Set();
      lastReplanSig = stateSig(obs, stuck);
      lastReplanT = obs.t;
    },

    decide(rb, obs) {
      const t = obs.t;
      const period = obs.period;
      if (lastDecisionT !== t) {
        lastDecisionT = t;
        claims = {};
        defClaims = {};
        // Re-search the SHIFT we are in if the world changed class since the plan was made — a ROBOT
        // went, the opponent went, the FIELD ran out of FUEL to cycle, or a role the plan assigned has
        // become impossible to execute. AUTO is 20 s and its plan is committed before anything is
        // observable, and TRANSITION is 10 s of both HUBs live, so neither is re-planned.
        if (!planOverride && period !== 'AUTO' && period !== 'TRANSITION' && t - lastReplanT >= REPLAN_COOLDOWN_SEC) {
          const sig = stateSig(obs, stuck);
          if (sig !== lastReplanSig) {
            lastReplanSig = sig;
            lastReplanT = t;
            planPeriod(period, obs);
          }
        }
        stuck = lastStuck;
        lastStuck = new Set();
      }
      // The posterior is only as good as its sample count, and period starts give it just seven
      // looks per MATCH. Re-observe on a timer so the END GAME TOWER read reflects behaviour
      // observed all match rather than a single snapshot.
      if (t - lastObserveT >= OBSERVE_EVERY_SEC) {
        lastObserveT = t;
        observe(obs);
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
        // No pile worth chasing: idle on this ROBOT's own shooting lane, not on a spot the whole
        // ALLIANCE shares (see GEO.shootStations).
        return ret(c0 ? { mode: INTENT.COLLECT, target: c0 } : { mode: INTENT.STOCKPILE, target: g.shootStations[rb.slot] });
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
          // The plan asked this ROBOT to deny somebody and there is nobody left to deny.
          lastStuck.add(rb.slot);
          role = ROLE.SCORE;
        }
      }

      const frac = rb.carrying / Math.max(1, rb.capacity);
      if (scoreCommit.get(rb.slot) && (!hubActive || rb.carrying === 0)) scoreCommit.set(rb.slot, false);
      if (scoreCommit.get(rb.slot)) {
        why.reason = 'dump-committed';
        return ret(scoreIntent(rb, obs));
      }

      // PASS: a collector stuck on the far half hands its load to a partner who is already home,
      // instead of making the whole trip back with it. Two conditions, because passing is not free —
      // the landing scatters, so somebody has to pick the FUEL up again: the load has to be worth
      // handing over, and the target has to be a real shortcut to the HUB rather than a lateral move.
      // The per-ROBOT posture comes from the setup panel: `auto` is this conservative rule, `eager`
      // lowers the bar and lets the aim point be our own ALLIANCE ZONE, `off` never throws.
      const passMode = rb.passMode || 'auto';
      if (passMode !== 'off') {
        const need = passMode === 'eager' ? weights.passEagerFrac : weights.passWhenFarFrac;
        if (frac >= need) {
          const pt = passTarget(rb, obs, passMode === 'eager');
          if (pt) {
            const myToHub = Math.hypot(rb.x - g.hub.x, rb.y - g.hub.y);
            const theirToHub = Math.hypot(pt.x - g.hub.x, pt.y - g.hub.y);
            // `eager` is the user overruling the planner's judgement about whether anybody is there to
            // catch it, so it only insists that the aim point really is nearer home than the ROBOT is.
            // `auto` keeps the strict economics test: a 150 in saving, which in practice means the play
            // only fires when it is unambiguous.
            const margin = passMode === 'eager' ? 60 : 150;
            if (theirToHub + margin < myToHub) {
              why.reason = `pass-${passMode}`;
              return ret({ mode: INTENT.PASS, target: pt });
            }
          }
        }
      }

      if (hubActive && rb.carrying > 0) {
        const left = secsUntilHubOff(obs);
        const start = (reason) => {
          scoreCommit.set(rb.slot, true);
          why.reason = reason;
          return ret(scoreIntent(rb, obs));
        };
        if (frac >= weights.dumpThreshold) return start(`dump-full(${left === null ? 'n/a' : left.toFixed(1)}s)`);
        if (left !== null && left <= weights.dumpBeforeIdleSec && frac >= weights.dumpBeforeIdleFrac) {
          return start(`dump-window(${left.toFixed(1)}s)`);
        }
        if (t > TIME.matchSec - 3) return start('dump-last3s');
      }

      // ---- our own HUB is inactive ----
      // During an ALLIANCE SHIFT we sit out the opponent's HUB is the active one (Table 6-3), so
      // parking in front of our own HUB accomplishes nothing: it cannot score and cannot bank. The
      // 25 s is still 25 s of MATCH, though, so this branch is an ordered ladder of the plays that
      // remain legal, and it has no IDLE outcome: standing still here throws away a sixth of the game.
      // Every rung is a deliberate choice — deny their window once we are too full to bank more, herd
      // FUEL if the user designated this ROBOT a pusher, gather for the next window, hand a load to a
      // partner who still has room so this ROBOT can keep sweeping, and failing all that put the body
      // on their shooter.
      if (!hubActive) {
        // 1. A ROBOT the user designated as a pusher herds loose FUEL home — the shift is free time for
        //    the job nobody has spare capacity for during our own window.
        if (rb.pushMode === 'active' && rb.carrying === 0) {
          const pt = pushTarget(rb, obs);
          if (pt) {
            why.reason = 'idle-push';
            return ret({ mode: INTENT.PUSH, target: pt });
          }
        }
        // 2. Bank FUEL for the window that opens next. This sits ABOVE the deny rung on measurement:
        //    with the ROBOTs going to defend at 81% fill instead of filling up, we lost ≈30 points and
        //    won 26% of MATCHes against the greedy baseline; banking first instead gave ≈+35 points and
        //    42% (two disjoint 24-MATCH seed sets). A full ROBOT has nothing to bank and falls through,
        //    and COLLECT is gated on room because a full intake swallows nothing — driving around with a
        //    full hopper is an IDLE frame wearing a different label.
        //
        //    It also sits above the rung below, and that ordering was re-tested on this build rather than
        //    inherited: gating the sweep on "can this pickup AND the return fit inside the time left"
        //    moved the proxy exactly the way you would hope — FUEL carried by a ROBOT off its own lane at
        //    the reopen fell from 37.8% to 14.3% — and cost 5.7 points of win rate, with all four seed
        //    families going down or flat (87.5→79.2, 81.3→75.0, 79.2→70.8, 70.8→70.8%). Being home in
        //    position is worth less than the load you did not pick up to get there, because the load is
        //    what the window is FOR. `scripts/cap.mjs` still prints the number so the trade stays visible.
        if (rb.carrying < rb.capacity) {
          const bankCell = pickCluster(rb, obs);
          if (bankCell) {
            why.reason = 'idle-bank';
            return ret({ mode: INTENT.COLLECT, target: { x: bankCell.x, y: bankCell.y } });
          }
        }
        // 2b. Our HUB is about to go live again. A ROBOT that is holding FUEL has one thing worth more
        //     than denying their window or delivering to the HP: being on its own shooting lane at the
        //     tick the window opens, because the load in its hopper is the only FUEL that can score on
        //     that tick. The dump rules above take over the moment obs.hub[side] flips, so this rung
        //     only has to get the ROBOT home in time. It sits above the deny and deliver rungs on
        //     purpose: both of them spend the load or the position this one is buying.
        const onIn = secsUntilHubOn(obs);
        if (rb.carrying > 0 && onIn !== null && onIn <= weights.darkPrepSec) {
          why.reason = `idle-prep(${onIn.toFixed(1)}s)`;
          return ret({ mode: INTENT.STOCKPILE, target: g.shootStations[rb.slot] });
        }
        // 2c. Hand the hopper to the HUMAN PLAYER at the OUTPOST. A full ROBOT has nothing left to
        //     bank, and the CORRAL takes FUEL it is already holding (§5.9.2), so this trades a load it
        //     cannot score this window for a whole window of sweeping, with the HP converting the load
        //     in parallel. Capped by worthDelivering: the HP throws far more slowly than a ROBOT does,
        //     so a backlog past its rate is FUEL taken off the FIELD for nothing.
        if (worthDelivering(obs, side, rb)) {
          why.reason = 'idle-feed';
          return ret({ mode: INTENT.FEED });
        }
        // 3. Nothing left to bank: deny their window instead.
        if (frac >= weights.pressWhenIdleFrac) {
          const tgt = pickDefenseTarget(rb, obs);
          if (tgt >= 0) {
            why.reason = 'idle-press';
            return ret({ mode: INTENT.DEFEND, targetRobot: tgt });
          }
        }
        // 4. Hand the load to a partner who still has room, so this ROBOT can go back out.
        if (frac > 0 && rb.passMode !== 'off') {
          const pt = passTarget(rb, obs, rb.passMode === 'eager');
          if (pt) {
            why.reason = 'idle-pass';
            return ret({ mode: INTENT.PASS, target: pt });
          }
        }
        // 5. Last productive option: deny their shooter wherever they are, at any fill level ("block").
        const blockTgt = pickDefenseTarget(rb, obs);
        if (blockTgt >= 0) {
          why.reason = 'idle-block';
          return ret({ mode: INTENT.DEFEND, targetRobot: blockTgt });
        }
        // 6. Truly nothing available: hold useful ground clear of the HUB face rather than standing on
        //    the spot their defender will camp next window. Each ROBOT backs off its OWN lane, so three
        //    idle ROBOTs queue up instead of shoving each other around one shared point.
        const back = side === 'red' ? -1 : 1;
        why.reason = 'idle-hold';
        lastStuck.add(rb.slot);
        return ret({ mode: INTENT.STOCKPILE, target: { x: g.shootStations[rb.slot].x + back * 60, y: g.shootStations[rb.slot].y } });
      }

      const cell = pickCluster(rb, obs);
      // An active pusher only swaps collecting for herding when collecting would mean crossing to the
      // far half anyway: then it herds FUEL home instead of dribbling it back one trip at a time. A
      // loaded ROBOT keeps to the dump rules above, and FUEL already on our half is simply collected.
      if (rb.pushMode === 'active' && rb.carrying === 0 && cell) {
        const far = side === 'red' ? cell.x > GEO.centerLineX : cell.x < GEO.centerLineX;
        if (far) {
          const pt = pushTarget(rb, obs);
          if (pt) {
            why.reason = 'push';
            return ret({ mode: INTENT.PUSH, target: pt });
          }
        }
      }
      why.reason = 'collect';
      if (!cell) lastStuck.add(rb.slot); // a SCORE role with no FUEL within reach anywhere on the FIELD
      return ret(cell ? { mode: INTENT.COLLECT, target: { x: cell.x, y: cell.y } } : { mode: INTENT.STOCKPILE, target: g.shootStations[rb.slot] });
    },

    // The HUMAN PLAYER is its own actor, not a ROBOT, so it gets its own decision rather than a slot
    // in `currentPlan`. The rule is shared with the baselines (ai.js) so the OUTPOST never becomes a
    // second, hidden difference between the two sides of a comparison.
    human(obs, side) {
      return humanChoice(obs, side);
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

