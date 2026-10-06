// Analytic ("fast") MATCH model.
//
// The full engine is faithful but costs ~30 ms per MATCH, which is far too slow for a search
// that needs thousands of rollouts. This module estimates a MATCH in a few microseconds from
// the same rule constants, so the macro planner can search over strategy instead of guessing.
// It is deliberately coarse: FUEL is a fluid pool, ROBOTs are throughput rates, and geometry is
// collapsed to two distances. Agreement with the engine is measured and reported in the
// benchmark panel rather than assumed.

import { TIME, POINTS, FIELD } from './rules.js';

export const ROLE = { SCORE: 'SCORE', DEFEND: 'DEFEND', CLIMB: 'CLIMB' };
export const PERIODS = ['AUTO', 'TRANSITION', 'SHIFT 1', 'SHIFT 2', 'SHIFT 3', 'SHIFT 4', 'END GAME'];

export function periodSeconds(period) {
  switch (period) {
    case 'AUTO':
      return TIME.autoSec;
    case 'TRANSITION':
      return TIME.transitionSec;
    case 'END GAME':
      return TIME.endgameSec;
    default:
      return TIME.shiftSec;
  }
}

// Per-alliance FUEL available close to home: 24 in the DEPOT plus 24 in the CHUTE the HUMAN
// PLAYER can enter (§6.3.4-A/B). The rest starts in the NEUTRAL ZONE.
export const NEAR_FUEL = 48;
export const NEUTRAL_FUEL = 504 - NEAR_FUEL - 48; // minus both ALLIANCES' preload allotment

export function makeContext({ schedule, caps, event, objective, weights }) {
  return {
    schedule,
    caps,
    event,
    objective,
    weights,
    thresholds: {
      energized: event === 'districtChamp' ? POINTS.rpThreshold.energized.districtChamp : POINTS.rpThreshold.energized.regional,
      supercharged: POINTS.rpThreshold.supercharged.regional,
      traversal: POINTS.rpThreshold.traversal.regional,
    },
  };
}

export function emptyPlan() {
  const roles = () => [ROLE.SCORE, ROLE.SCORE, ROLE.SCORE];
  const periods = {};
  for (const p of PERIODS) periods[p] = roles();
  return {
    auto: { fuelTarget: 1, climbCount: 1 },
    periods,
    climb: { count: 3, levels: [3, 3, 2], startAt: TIME.matchSec - TIME.endgameSec + 4 },
  };
}

// Distances collapsed from §5 geometry: DEPOT/OUTPOST are on the ALLIANCE WALL, the NEUTRAL
// ZONE starts past the HUB. The HUB opening is only shootable from inside the ALLIANCE ZONE
// (G407), so every cycle is out-and-back.
const D_NEAR = 150;
const D_FAR = 265;

function cycleOf(cap, dist, w) {
  const payload = Math.max(1, Math.min(cap.capacity, cap.intake * w.loadSeconds));
  const travel = (2 * dist) / Math.max(30, cap.speed) + w.traversalOverhead;
  const cycle = travel + payload / Math.max(0.2, cap.intake) + payload / Math.max(0.2, cap.shootRate) + w.aimOverhead;
  return { payload, cycle, rate: payload / cycle };
}

function climbPoints(level, towerL1TeleopAllowed) {
  if (level <= 0) return 0;
  if (level === 1) return towerL1TeleopAllowed ? POINTS.tower.l1Teleop : 0;
  if (level === 2) return POINTS.tower.l2Teleop;
  return POINTS.tower.l3Teleop;
}

// Estimate one ALLIANCE's MATCH output given both plans. Mirrors the engine's scoring order:
// AUTO fuel, the ALLIANCE SHIFT windows from Table 6-3, then END GAME with both HUBs active.
export function estimateAlliance(ctx, side, ownPlan, oppPlan, towerL1TeleopAllowed) {
  const w = ctx.weights;
  const caps = ctx.caps[side];
  const oppCaps = ctx.caps[side === 'red' ? 'blue' : 'red'];
  let near = NEAR_FUEL;
  let neutral = NEUTRAL_FUEL;
  let fuel = 0;
  let tower = 0;
  let towerTeleop = 0;

  const consume = (amount) => {
    const fromNear = Math.min(near, amount);
    near -= fromNear;
    const rest = amount - fromNear;
    neutral = Math.max(0, neutral - rest);
    return fromNear / Math.max(0.001, amount);
  };

  // ---- AUTO (both HUBs active, Table 6-3) ----
  const autoSec = TIME.autoSec;
  const climbersAuto = ownPlan.auto.climbCount;
  for (let i = 0; i < 3; i++) {
    if (i < climbersAuto) {
      const risk = 1 - Math.min(1, caps[i].climb.timeSec + caps[i].climb.attachTimeSec) / autoSec;
      if (caps[i].climb.max >= 1 && risk > 0) tower += POINTS.tower.l1Auto;
      continue;
    }
    const c = cycleOf(caps[i], D_NEAR, w);
    const shots = Math.min(c.payload * ownPlan.auto.fuelTarget, (autoSec / c.cycle) * c.payload);
    const made = shots * caps[i].accuracy;
    fuel += made;
    consume(made);
  }

  // ---- TELEOP periods ----
  const oppDefendersAll = oppPlan.periods;
  for (const row of ctx.schedule) {
    if (row.period === 'AUTO') continue;
    const sec = periodSeconds(row.period);
    const hubActive = row[side];
    const roles = ownPlan.periods[row.period];
    const oppRoles = oppPlan.periods[row.period];

    // Score potential per ROBOT for this period.
    const rates = caps.map((cap, i) => {
      if (roles[i] !== ROLE.SCORE) return 0;
      const wNear = near / Math.max(1, near + neutral * 0.35);
      const dist = D_NEAR * wNear + D_FAR * (1 - wNear);
      return cycleOf(cap, dist, w).rate;
    });

    // Opponent defenders deny our best ROBOTs first.
    const defenders = oppRoles.filter((r) => r === ROLE.DEFEND).length;
    for (let k = 0; k < defenders; k++) {
      let bestIdx = -1;
      let bestRate = 0;
      for (let i = 0; i < 3; i++) if (rates[i] > bestRate) { bestRate = rates[i]; bestIdx = i; }
      if (bestIdx < 0) break;
      const skill = oppCaps[bestIdx] ? oppCaps[0].defenseSkill : 0.5;
      rates[bestIdx] *= 1 / (1 + w.defenseEfficacy * skill);
    }

    for (let i = 0; i < 3; i++) {
      if (roles[i] !== ROLE.SCORE) continue;
      if (row.period === 'END GAME' && i < ownPlan.climb.count) {
        // A climbing ROBOT stops scoring at climbStart; only pre-climb time counts.
        const before = Math.max(0, ownPlan.climb.startAt - (TIME.matchSec - TIME.endgameSec));
        const c = cycleOf(caps[i], D_FAR, w);
        const made = hubActive ? (before / c.cycle) * c.payload * caps[i].accuracy : 0;
        fuel += made;
        consume(made);
        const level = ownPlan.climb.levels[i] || 3;
        const fit = (sec - before) / Math.max(1, caps[i].climb.timeSec + caps[i].climb.attachTimeSec);
        if (fit >= 1 && caps[i].climb.max >= level) {
          tower += climbPoints(level, towerL1TeleopAllowed);
          towerTeleop += climbPoints(level, towerL1TeleopAllowed);
        }
        continue;
      }
      if (!hubActive) {
        // HUB inactive: the ROBOT banks a full load and dumps it the moment the HUB returns.
        continue;
      }
      const c = cycleOf(caps[i], near > 0 ? D_NEAR : D_FAR, w);
      const cycles = sec / c.cycle;
      const made = cycles * c.payload * caps[i].accuracy;
      fuel += made;
      consume(made);
    }
  }

  // Banked burst: an inactive ALLIANCE SHIFT is followed by an active one (Table 6-3), so a
  // full payload is released almost instantly when the HUB returns.
  let banked = 0;
  for (let s = 0; s < 4; s++) {
    const prev = ctx.schedule.find((r) => r.period === `SHIFT ${s}`);
    const next = ctx.schedule.find((r) => r.period === `SHIFT ${s + 1}`);
    if (prev && next && !prev[side] && next[side]) {
      for (let i = 0; i < 3; i++) {
        if (ownPlan.periods[next.period][i] === ROLE.SCORE) banked += caps[i].capacity * caps[i].accuracy * w.bankCredit;
      }
    }
  }
  fuel += banked;

  // modelEfficiency calibrates the fluid estimate against the engine's observed output; it is a
  // policy weight so self-play can keep the search honest as the other weights move.
  const eff = w.modelEfficiency == null ? 0.85 : w.modelEfficiency;
  return { fuel: fuel * eff, tower, towerTeleop, near, neutral };
}

// Expected Ranking Points for one ALLIANCE (Table 6-4 / 6-5), using a normal approximation for
// MATCH-point uncertainty because a deterministic estimate would always be 0 or 1 on RP.
function expectedRP(ownScore, oppScore, own, ctx, spread) {
  const sd = Math.max(6, spread * (ownScore + oppScore) * 0.5);
  const margin = ownScore - oppScore;
  const p = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
  const pWin = p(margin / sd);
  const pTie = 0.12; // approximate tie mass; MATCH-point ties are rare but do occur
  const th = ctx.thresholds;
  const t = ctx.spread || sd;
  const pEnergized = p((own.fuel - th.energized) / Math.max(8, t * 0.35));
  const pSuper = p((own.fuel - th.supercharged) / Math.max(8, t * 0.35));
  const pTraversal = own.tower >= th.traversal ? 1 : 0;
  const rp = pWin * (1 - pTie) * POINTS.rp.win + pTie * POINTS.rp.tie + pEnergized + pSuper + pTraversal;
  return { rp, pWin, pEnergized, pSuper, pTraversal };
}

function erf(x) {
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
}

export function evaluateMatch(ctx, ownSide, ownPlan, oppPlan, opts = {}) {
  const other = ownSide === 'red' ? 'blue' : 'red';
  const towerL1 = opts.towerL1TeleopAllowed !== false;
  const own = estimateAlliance(ctx, ownSide, ownPlan, oppPlan, towerL1);
  const opp = estimateAlliance(ctx, other, oppPlan, ownPlan, towerL1);
  const ownScore = own.fuel * POINTS.fuelActiveHub + own.tower;
  const oppScore = opp.fuel * POINTS.fuelActiveHub + opp.tower;
  const spread = opts.spread || 0.16;
  const o = expectedRP(ownScore, oppScore, own, ctx, spread);
  const x = expectedRP(oppScore, ownScore, opp, ctx, spread);
  const utility = ctx.objective === 'win' ? o.pWin * 3 + o.pTraversal : o.rp;
  return { ownScore, oppScore, own, opp, ownRP: o, oppRP: x, utility, oppUtility: ctx.objective === 'win' ? x.pWin * 3 + x.pTraversal : x.rp };
}

// Candidate role assignments for a period. Symmetric permutations of identical ROBOTs collapse,
// which keeps the branching factor near 18 instead of 27.
export function roleCandidates(n = 3) {
  const out = [];
  const seen = new Set();
  const rec = (arr) => {
    if (arr.length === n) {
      const counts = { SCORE: 0, DEFEND: 0, CLIMB: 0 };
      for (const r of arr) counts[r] += 1;
      const key = `${counts.SCORE}-${counts.DEFEND}-${counts.CLIMB}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(arr.slice());
      }
      return;
    }
    for (const r of [ROLE.SCORE, ROLE.DEFEND, ROLE.CLIMB]) rec([...arr, r]);
  };
  rec([]);
  return out;
}

export function withRoles(plan, period, roles) {
  const p = { ...plan, periods: { ...plan.periods, [period]: roles.slice() } };
  return p;
}

export function withClimb(plan, climb) {
  return { ...plan, climb: { ...plan.climb, ...climb } };
}

export function withAuto(plan, auto) {
  return { ...plan, auto: { ...plan.auto, ...auto } };
}

export const GEOM = { D_NEAR, D_FAR, HUB_HALF: FIELD.hub.sizeIn / 2 };
