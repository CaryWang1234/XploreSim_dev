// Analytic ("fast") MATCH model.
//
// The full engine is faithful but costs ~30 ms per MATCH, which is far too slow for a search
// that needs thousands of rollouts. This module estimates a MATCH in a few microseconds from
// the same rule constants, so the macro planner can search over strategy instead of guessing.
// It is deliberately coarse: FUEL is a fluid pool, ROBOTs are throughput rates, and geometry is
// collapsed to two distances. Agreement with the engine is measured and reported in the
// benchmark panel rather than assumed.

import { TIME, POINTS, FIELD, rpBars } from './rules.js';

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
    thresholds: rpBars(event),
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

// §6.5.2: an AUTO climb does not block a TELEOP climb, which only means anything if the ROBOT gets
// back down. L1 is a ~27 in rung so the drop is quick but not free, and it lands in TRANSITION
// SHIFT — 10 s with both HUBs active. The engine charges the same time, so the model has to.
const AUTO_DISMOUNT_SEC = 1.5;

function cycleOf(cap, dist, w) {
  // A ROBOT leaves the collection area when it is full. Capping the payload by a collection-time
  // budget made an 85-FUEL hopper indistinguishable from a 50-FUEL one, which is exactly the
  // difference the search has to see to pick a plan.
  const payload = Math.max(1, cap.capacity);
  // A turret does not drive the last leg to the HUB face and does not pay a separate alignment
  // stop: it fires on the way in. A full-width Dumper pays both, which is why it carries a bigger
  // payload to amortise the trip.
  const turret = cap.mechanism === 'turret';
  const travel = (2 * (turret ? dist * 0.78 : dist)) / Math.max(30, cap.speed) + w.traversalOverhead;
  const aim = turret ? w.aimOverhead * 0.3 : w.aimOverhead;
  const cycle = travel + payload / Math.max(0.2, cap.intake) + payload / Math.max(0.2, cap.shootRate) + aim;
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
  // Every loop below runs over `caps`, not over a fixed three: an ALLIANCE can field one or two
  // ROBOTs (see the bench switch in the model), and the plan is a 3-slot template either way.
  for (let i = 0; i < caps.length; i++) {
    if (i < climbersAuto) {
      const risk = 1 - Math.min(1, caps[i].climb.timeSec + caps[i].climb.attachTimeSec) / autoSec;
      if (caps[i].climb.max >= 1 && risk > 0) tower += POINTS.tower.l1Auto;
      continue;
    }
    const c = cycleOf(caps[i], D_NEAR, w);
    const shots = Math.min(c.payload * ownPlan.auto.fuelTarget, (autoSec / c.cycle) * c.payload);
    // A card that declares its AUTO is a measurement, so the planner uses it: the engine fires that load
    // with certainty and keeps the machine's mouth shut for the 20 seconds, which means the cycle model
    // below would be planning a play the MATCH will not contain. Cards that declare nothing keep exactly
    // the estimate this function has always returned.
    const declared = caps[i].autoRoutine;
    const made = declared === null || declared === undefined ? shots * caps[i].accuracy : Math.min(declared, caps[i].capacity);
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
    // A ROBOT that climbed in AUTO spends the opening of TRANSITION getting back onto the carpet,
    // so its scoring time in that period is short by the dismount.
    const secFor = (i) => (row.period === 'TRANSITION' && i < climbersAuto ? Math.max(0, sec - AUTO_DISMOUNT_SEC) : sec);

    // Score potential per ROBOT for this period.
    const rates = caps.map((cap, i) => {
      if (roles[i] !== ROLE.SCORE) return 0;
      const wNear = near / Math.max(1, near + neutral * 0.35);
      const dist = D_NEAR * wNear + D_FAR * (1 - wNear);
      return cycleOf(cap, dist, w).rate;
    });

    // Opponent defenders deny our best ROBOTs, and the suppression now has to REACH the estimate.
    // This block used to scale `rates` and then throw the array away — the scoring loop below
    // recomputed each ROBOT's output from cycleOf — so defenseEfficacy was dead code, DEFEND cost the
    // search nothing, and it parked two ROBOTs on defence in every window it sat out.
    //
    // ONE defender's worth used to be the whole story: the engine kept `tgt.defensePressure =
    // max(pressure over attackers)`, so a second ROBOT shadowing the same opponent added nothing, and
    // multiplying a factor per defender made a two-defender plan look twice as strong as it was. That
    // was true while defence was only a rate penalty. Since the body became a square and a shot became
    // a swept line, defence also BLOCKS launches, and blocking does sum per defender — measured by
    // `scripts/defcal.mjs` (48 MATCHes per arm, one trio on both ALLIANCES, red pinned all-SCORE):
    //     k defenders   opponent FUEL   factor   launches blocked per MATCH
    //     0             672.2           1.000    6.0
    //     1             620.3           0.923    24.3
    //     2             550.3           0.819    45.2
    //     3             467.1           0.695    98.8
    // so the marginal defender costs the attacker about as much as the first, and the per-defender
    // product is the right shape now. It is applied to the top-k attackers, because a defender shadows
    // one opponent at a time; the fit is deliberately the k=1 number, which under-prices k=2 rather
    // than over-prices it, since over-pricing defence is the failure this search has had twice.
    const rateScale = caps.map(() => 1);
    const defenderSlots = [];
    for (let i = 0; i < Math.min(oppRoles ? oppRoles.length : 0, oppCaps.length); i++) {
      if (oppRoles[i] === ROLE.DEFEND) defenderSlots.push(i);
    }
    if (defenderSlots.length && w.defenseEfficacy > 0) {
      const skill = Math.max(...defenderSlots.map((i) => (oppCaps[i] && oppCaps[i].defenseSkill) || 0.5));
      const perDefender = 1 / (1 + w.defenseEfficacy * skill);
      const ranked = rates.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r);
      for (let d = 0; d < Math.min(defenderSlots.length, ranked.length); d++) {
        const i = ranked[d].i;
        rates[i] *= perDefender;
        rateScale[i] *= perDefender;
      }
    }

    for (let i = 0; i < caps.length; i++) {
      if (roles[i] !== ROLE.SCORE) continue;
      if (row.period === 'END GAME' && i < ownPlan.climb.count) {
        // A climbing ROBOT stops scoring at climbStart; only pre-climb time counts.
        const before = Math.max(0, ownPlan.climb.startAt - (TIME.matchSec - TIME.endgameSec));
        const c = cycleOf(caps[i], D_FAR, w);
        const made = hubActive ? (before / c.cycle) * c.payload * caps[i].accuracy * rateScale[i] : 0;
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
      const cycles = secFor(i) / c.cycle;
      const made = cycles * c.payload * caps[i].accuracy * rateScale[i];
      fuel += made;
      consume(made);
    }
  }

  // Banked burst: an inactive ALLIANCE SHIFT is followed by an active one (Table 6-3), so a ROBOT
  // that spent the inactive SHIFT loading up dumps almost instantly when the HUB returns.
  //
  // Both halves of that sentence have to be in the condition. Crediting the bank for SCORE in
  // `next` alone made DEFEND free during your own inactive window — a SCORE role there produces 0
  // FUEL anyway (the loop above skips inactive periods), so the search happily parked ROBOTs on
  // defence and lost the load they should have been gathering. Requiring the ROBOT to have been
  // collecting in `prev` is what gives sitting out a real alternative. It walks consecutive rows
  // rather than SHIFT s -> SHIFT s+1 so that SHIFT 4 -> END GAME is covered too: otherwise the
  // LAST inactive window, which is 25 of the 55 s a losing ALLIANCE sits out, was written off as
  // worth nothing.
  let banked = 0;
  for (let k = 0; k < ctx.schedule.length - 1; k++) {
    const prev = ctx.schedule[k];
    const next = ctx.schedule[k + 1];
    if (prev.period === 'AUTO' || prev[side] || !next[side]) continue;
    for (let i = 0; i < caps.length; i++) {
      const collecting = ownPlan.periods[prev.period][i] === ROLE.SCORE;
      const readyToDump = ownPlan.periods[next.period][i] === ROLE.SCORE;
      if (collecting && readyToDump) banked += caps[i].capacity * caps[i].accuracy * w.bankCredit;
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
//
// It is tempting to also let the search choose WHICH ROBOT takes the DEFEND slot, since the
// reference ALLIANCE has defence skills from 0.5 to 0.86 and the collapse always puts a lone
// defender on the highest slot. That was implemented, measured and reverted: over 96 MATCHES
// against greedy on four seed families it moved the win rate from 46% to 38% and the average score
// from 657 to 647, because the extra candidates are extra ways to buy DEFEND, and the search's
// appetite for DEFEND is the expensive part (see the defence note in estimateAlliance). The
// narrower list was the better accidental brake.
export function roleCandidates(n = 3) {
  const out = [];
  const seen = new Set();
  const rec = (arr) => {
    if (arr.length === n) {
      const counts = { SCORE: 0, DEFEND: 0 };
      for (const r of arr) counts[r] += 1;
      const key = `${counts.SCORE}-${counts.DEFEND}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(arr.slice());
      }
      return;
    }
    // Climbing is a MATCH-level ladder (plan.climb), not a per-period role: the engine policy never
    // reads a CLIMB role, so generating one only halved the useful search space and printed a
    // "climb" cell in a SHIFT where nothing can climb.
    for (const r of [ROLE.SCORE, ROLE.DEFEND]) rec([...arr, r]);
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
