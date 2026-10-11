// REBUILT MATCH engine. The engine owns kinematics, FUEL flow and the manual's rules, and it
// never decides strategy: an injected policy returns only an INTENT per ROBOT while the engine
// executes, adjudicates and scores. Keeping decisions out of the engine means the same engine
// can score a hand-written plan, a naive bot, or the search-based AI without favouring either.

import { TIME, POINTS, FUEL, FIELD, hubActiveTable } from './rules.js';
import { periodAt, defaultScenario } from './model.js';
import { makeRng } from './rng.js';

export const INTENT = {
  IDLE: 'IDLE',
  COLLECT: 'COLLECT',
  STOCKPILE: 'STOCKPILE',
  SCORE: 'SCORE',
  PASS: 'PASS',
  PUSH: 'PUSH',
  DEFEND: 'DEFEND',
  CLIMB: 'CLIMB',
  FEED: 'FEED',
};

// What a ROBOT can still do: its own breakdown (a fault, see faultsEnabled) and the CONTACT_IMPAIR_SEC
// after a damaging contact both scale the rollers, the shooter and the drive, and the worse of the two
// is what applies. Impairment is a timer rather than a permanent state, because the manual's own
// "unable to drive" is a 20-second window, not a wreck.
const capability = (rb) => Math.min(rb.health, rb.impairLeft > 0 ? rb.impairFactor : 1);

// A PASS throws FUEL toward a partner instead of at a HUB, so it flies longer and lands loose.
const PASS_FLIGHT_SEC = 1.1;
// A PASS aim point has to clear the HUB box, because FUEL has to land on the FIELD: the point of the
// check is physical, not anti-exploit. A pass cannot score by construction — resolveFlight awards
// nothing for fhub === 3 — and FUEL dropped at a HUB mouth is self-limiting anyway, because loitering
// there to scoop it up is exactly what G408 fouls.
const PASS_HUB_CLEARANCE_IN = 40;
// A ROBOT driving into loose FUEL shoves it along at this fraction of its own ground speed. Like
// `hubExitRate`, a scenario may override it (sc.bulldoze ?? this) so the effect can be measured
// against a control with the pushing switched off.
const BULLDOZE_FACTOR = 0.8;
// FUEL is "a 5.91in (15.0cm) diameter, high density foam ball" (§5.10.1), so its radius is 2.955 in.
// It is used wherever a ball meets a structure — a ball stops against a TOWER or a HUB instead of
// ending up inside one — and as the spacing a new ball keeps from the ones already on the carpet. It
// was 6 in for a long time, twice the real size, which drew balls overlapping each other on the
// replay and packed a DEPOT's 24 FUEL into a corner it does not fit in.
const FUEL_RADIUS_IN = 5.91 / 2;
// A shot is a straight, low line from the ROBOT to the HUB opening, so an opponent whose BUMPERS
// straddle that line really is in the way. The ROBOT is a square, so how much of the lane it covers
// depends on how it is turned: squared up to the lane it blocks its own side (13.75 in for the R104
// perimeter) plus the FUEL's radius, corner-on it reaches sqrt(2) further. `shotBlockRadius()` computes
// the real number per blocker from its heading; this constant is the corner-on worst case, and it is
// what the policy compares against when it is deciding whether a lane is worth giving up, because the
// policy does not get to assume the defender will stay square. This is what turns DEFEND from a rate
// penalty into a play that can take a Dumper's shots away outright.
const SHOT_BLOCK_RADIUS_IN = 22;
// §7.4.4 G415/G416/G417 are the three opponent-interaction rules, and the manual is explicit that
// they need more than contact: G415 example A is a hit "inside their ROBOT PERIMETER" with "no damage
// seen so no violation is assigned", and G416 example G is "driving at high speed makes BUMPER to
// BUMPER contact with an opponent" and is NOT reckless. So an ordinary collision is legal play, and a
// violation needs the contact to damage or functionally impair an opponent (G415, G416) or to tip or
// entangle it (G417). This engine has no mechanisms to break, so "damage" is modelled as an impulse
// the victim cannot absorb: the closing speed of the contact scaled by how much heavier the rammer is.
// Measured inside the engine (10 AI-vs-greedy matches, every contact adjudicated, 661 collisions) that
// severity has a median of 18 in/s, a 90th percentile of 95, a 95th of 143 and a maximum of 196, so
// CONTACT_HIT_SEVERITY sits at the 90th percentile and CONTACT_IMPAIR_RAMP turns "a hard hit" into "a
// hard hit that broke something" only in the tail rather than on every bump. The probability itself is
// an assumption with no real-world anchor (see the site's "Hard contact" section): real Einstein
// finals show 0, 1 and 2 fouls a match, and this family has to land inside that or below it. It is the
// one knob here that is not measured, which is why the whole family is off by default. All three
// thresholds and the probability take a scenario override (sc.contactHitSeverity, sc.contactImpairP,
// sc.contactTipSeverity) so the switches, the rule selection and the cards can be measured and checked
// against a control.
const CONTACT_HIT_SEVERITY = 130;
const CONTACT_IMPAIR_RAMP = 500;
const CONTACT_MAX_IMPAIR_P = 0.15;
// Deliberate means the rammer was pressuring THIS opponent (a DEFEND intent aimed at it), which is
// what separates "intentionally and/or recklessly" (G416) and a deliberate tip (G417) from two
// ROBOTs converging on the same pile. Pressing an opponent is not by itself tipping it, so G417 needs
// the deliberate hit to be in the extreme tail of the measured severity distribution as well.
const CONTACT_TIP_SEVERITY = 185;
// "Unable to drive" means "for approximately ~20+ seconds, the DRIVER can no longer drive to a
// desired location in a reasonable time", so the worst case is timed at that. The milder outcome the
// manual's examples show (a dropped intake, MAJOR FOUL + YELLOW CARD) is a shorter, smaller hit on
// capability: measured against a control, it has to stay worth less than the 15 points the foul hands
// the opponent, or ramming an opponent becomes a profitable play in this engine - and the real
// deterrent for that (a second YELLOW CARD in a phase is a RED CARD, which is a DISQUALIFICATION) is
// tournament bookkeeping this single-MATCH model does not carry.
const CONTACT_IMPAIR_SEC = 20;
const CONTACT_IMPAIR_MINOR_SEC = 15;
const CONTACT_IMPAIR_FACTOR = 0.7;
const CONTACT_UNABLE_SEVERITY = 190;
export { CONTACT_UNABLE_SEVERITY, CONTACT_HIT_SEVERITY, CONTACT_IMPAIR_SEC };
// The BUMPER half-width the engine falls back to when a ROBOT carries no perimeter of its own, and the
// reach used for the G415 test: a ROBOT is "completely outside" its ALLIANCE ZONE only once the near
// edge of its box has cleared the zone line. Separation itself is no longer a fixed centre distance -
// ROBOTs are oriented squares and squareContact() resolves them face-to-face or corner-to-corner.
const ROBOT_SEPARATION_IN = 28;
const ROBOT_PERIMETER_HALF_IN = ROBOT_SEPARATION_IN / 2;
// Coefficient of restitution for BUMPER-to-BUMPER contact, applied along the contact normal with an
// impulse that conserves momentum. 0 is perfectly inelastic (the two meet and stop, which is what
// removes the old artefact of two ROBOTs driving through each other for a second and a half while the
// positional correction crawled them apart); -1 switches the impulse off and leaves the positional
// correction alone, which is the control the A/B and the verifier measure against. BUMPERS are foam
// over plywood and absorb most of a hit, so the shipped value is just above perfectly inelastic.
const CONTACT_RESTITUTION = 0.12;
const CONTACT_FOUL_TEXT = {
  G415: 'damage by contact initiated from outside the ALLIANCE ZONE',
  G416: 'reckless damage to an opponent ROBOT',
  G417: 'tipping an opponent ROBOT',
};
// The two shooter architectures are a real trade rather than a label. A TURRET slews onto the HUB and
// fires from anywhere in its ALLIANCE ZONE while still rolling, so its aim time is nearly nothing; a
// full-width DUMPER has to reach the HUB face, stop, and wait out its spin-up, because the whole
// hopper leaves at once. That spin-up is the whole difference between the two aim times, and it is
// deliberately long. Measured on an all-turret against an all-dumper ALLIANCE of one profile, sides
// alternating so the hub-activation asymmetry cancels, 72 matches on each of two seed sets: the old
// 0.15 / 0.7 pair leaves the two 30 and 33 points apart (turret winning 72% and 71%), and this pair
// separates them to 51 and 48 (82% and 82%). So the spin-up is worth about 18 of that; the rest is
// the rest of the mechanism - fire on the move, no alignment trip - which pays more now that a missed
// shot comes down at the HUB, because a turret can be shooting and collecting there at the same time.
// Do not shrink it back without re-measuring: the aim contrast is the part that scales with how long
// a DUMPER parks, and at the old pair the two were within a couple of points before the net change.
// The turret's own aim time barely matters (its score does not move between 0 and 0.15), so it stays
// small and round.
const TURRET_AIM_SEC = 0.1;
const DUMPER_AIM_SEC = 1.5;
// How far past its reference shooting distance a turret will still take a shot it did not stop for.
// Beyond that the accuracy falloff (see releaseShot) has eaten enough of the make rate that holding the
// FUEL for a real firing spot is worth more than the free launch.
const TURRET_OPPORTUNITY_MARGIN_IN = 70;
const DUMPER_ALIGN_IN = 46; // how close to the shared HUB-face point a DUMPER has to be to dump; policy.js
                            // keeps its own ALIGN_RADIUS_IN in step with this, since the AI picks its
                            // firing spot from that circle and the engine is what decides if it counts
// §5.4: "A net structure located in the back of the HUB prevents FUEL launched from most prohibited
// areas from entering the opening." The prohibited areas are outside your own ALLIANCE ZONE, and the
// HUB sits exactly on the zone line, so a ROBOT shooting at its own HUB from behind it would be
// firing into the net. That shot is modelled as never leaving the hopper (see the SCORE action), and
// the backstop in resolveFlight drops the ball at the net if one ever does get airborne.
const NET_DROP_NEAR_IN = 2;
const NET_DROP_FAR_IN = 14;
// How far in front of the HUB's near face a shot that missed the opening comes down. It fell at the
// base of the structure it hit, so it does not scatter across the FIELD the way a made shot's return
// does.
const MISS_DROP_FAR_IN = 30;
// Two FUEL are balls on the carpet and cannot occupy the same point, but every landing in the engine
// is an independent random draw — a HUB exit, a CHUTE dump, a shot coming down — so balls can land
// stacked. This is the minimum centre-to-centre spacing placeLoose() enforces for a new ball, in
// inches: one diameter, so two balls may touch but never overlap.
const FUEL_SEPARATION_IN = FUEL_RADIUS_IN * 2;
export { SHOT_BLOCK_RADIUS_IN };
// Recorded frames per engine tick. The replay interpolates, so this sets how much of a turn the
// interpolator has to invent: every tick keeps it to ≤15 in of ROBOT travel at top speed.
const RECORD_EVERY_TICKS = 1;

// ---- HUMAN PLAYER (§5.9.2, G423, G425, G427) ----
// The CHUTE DOOR is an HDPE arm on a pivot the HP rotates about 90° to open or close the CHUTE.
const DOOR_SWING_SEC = 0.6;
// With the door out of the way FUEL slides down the 15° tunnel and out the upper opening (§5.9.2), so
// the whole ~25 FUEL store drains in a few seconds. That burst is the alliance's field supply.
const DUMP_PER_SEC = 7.0;
// G427: an HP may hold up to 2 FUEL off the FIELD while moving it.
const HP_HAND_CAP = 2;
// FUEL state 5 is "in an HP's hand". It is separate from state 3 (a ROBOT's hopper) because the
// intake, the bulldoze pass and the held-FUEL ride-along are all keyed off "which ROBOT holds this".
const HP_HAND = 5;
// A throw is a lob from the OUTPOST into the HUB: longer than a ROBOT's shot, and flat enough that it
// reuses the same flight integrator and tracer.
const HUMAN_FLIGHT_SEC = 0.7;

const other = (a) => (a === 'red' ? 'blue' : 'red');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Where a held FUEL sits inside its ROBOT's footprint. Precomputed instead of a cos/sin per ball per
// tick, which showed up in the profile for no benefit — it only has to keep a full hopper from
// collapsing into a single dot.
const HELD_OFFSET = Array.from({ length: 12 }, (_, k) => [Math.cos(k * 2.399) * 5, Math.sin(k * 2.399) * 5]);

// Shortest distance from a point to a line segment. Shared by the engine's shot-block test and the
// AI's choice of a firing spot, so "is my lane clear?" and "did that shot get stopped?" can never
// disagree about the same geometry.
export function segmentPointDistance(ax, ay, bx, by, px, py) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-9) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// ---- square ROBOTs: heading, turning and oriented collision ----
// A ROBOT is a square (R104 caps the STARTING CONFIGURATION perimeter at 110 in, so 27.5 in a side),
// and once it has a front that front matters twice over: the intake is a slot across one face and a Dumper's
// shooter is bolted to it. So the heading is its own state, integrated under the ROBOT's turn rate,
// instead of being read back out of the velocity.
const DEG = Math.PI / 180;
// Signed smallest difference between two bearings, in degrees, in (-180, 180].
export function angleDeltaDeg(a, b) {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}
export const bearingDeg = (dx, dy) => Math.atan2(dy, dx) / DEG;

// Half-width of a square ROBOT's footprint, from its recorded perimeter.
export const footprintHalf = (rb) => rb.footprintHalfIn || ROBOT_PERIMETER_HALF_IN;

// A roller intake runs bumper to bumper, so its mouth is the whole face: FUEL anywhere in front of
// that face and no wider than the car is swept up. `MOUTH_REACH_IN` is how far BEHIND the face line
// the rollers still reach, which is how a ROBOT that has already driven past a pile keeps eating it.
// It is the one number here that is a guess rather than a geometry, so `sc.intakeReach` overrides it
// and the greedy mirror is what settles it: on the current engine the same 192-MATCH mirror reads 615.7
// at 6 in, 612.9 at 7 and 632.1 at 12. Six inches ships because that is what a ball resting against a
// bumper is worth, not because it is the highest score, and scripts/golden.mjs fails when it moves.
export const MOUTH_REACH_IN = 6;

// Projected half-width of a square onto a world axis: the two edge directions each contribute their
// own half-extent times the cosine of the angle to the axis.
function projectHalf(h, heading, ux, uy) {
  const c = Math.cos(heading);
  const s = Math.sin(heading);
  return h * (Math.abs(ux * c + uy * s) + Math.abs(ux * -s + uy * c));
}

// Separating-axis test for two oriented squares. Returns the shallowest penetration and the world axis
// it is measured along, pointing from `a` to `b`, or null when the boxes are apart. Testing only the
// centre distance (the old circle) let two ROBOTs turned 45° to each other overlap corner-to-corner by
// 11 in, and testing only the world axes let two turned ROBOTs pass through each other, so all four of
// their own axes are tested.
export function squareContact(a, b) {
  const ha = footprintHalf(a);
  const hb = footprintHalf(b);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  // Broad phase on the circumscribed circles: a square of half-width h never reaches past h*sqrt(2).
  if (Math.hypot(dx, dy) > (ha + hb) * 1.4143) return null;
  const ca = Math.cos(a.heading);
  const sa = Math.sin(a.heading);
  const cb = Math.cos(b.heading);
  const sb = Math.sin(b.heading);
  const axes = [ca, sa, -sa, ca, cb, sb, -sb, cb];
  let best = null;
  for (let k = 0; k < 4; k++) {
    const ux = axes[k * 2];
    const uy = axes[k * 2 + 1];
    const overlap = projectHalf(ha, a.heading, ux, uy) + projectHalf(hb, b.heading, ux, uy) - Math.abs(dx * ux + dy * uy);
    if (overlap <= 0) return null;
    if (!best || overlap < best.pen) {
      const s = dx * ux + dy * uy >= 0 ? 1 : -1;
      best = { pen: overlap, ux: ux * s, uy: uy * s };
    }
  }
  return best;
}

// The angle a full-width Dumper's shooter is bolted at, in the ROBOT's own frame, 0° being straight
// ahead. It only fires with that face turned onto the HUB, within this tolerance: a shooter 25 in
// between the side plates is aimed by pointing the ROBOT, and the hood has to be roughly square to the
// goal or the whole hopper goes wide. A turret slews, so none of this reaches it.
const DUMPER_FACE_TOL_DEG = 20;
export { DUMPER_FACE_TOL_DEG };

// How much of a shot lane a blocker covers, given the lane's normal: the blocker's own projected
// half-width plus the FUEL's radius, because the ball is stopped when it touches the BUMPER, not when
// its centre crosses the ROBOT's centreline. `SHOT_BLOCK_RADIUS_IN` is the corner-on worst case of this
// and is what a policy compares against when it cannot know how the defender will be turned.
export function shotBlockRadius(rb, nx, ny) {
  return projectHalf(footprintHalf(rb), rb.heading || 0, nx, ny) + FUEL_RADIUS_IN;
}

// How much of a ROBOT's intake throughput an opponent in contact takes away, at full defence
// pressure. Defence in this game has to be able to matter: real MATCH scores sit well under an
// undefended simulation, and the four BUMPS/TRENCHES plus one HUB face make a single defender able
// to park itself in the way. Kept below the drive-speed and shoot-rate losses because a ROBOT that
// is merely being shadowed can still sweep FUEL off to the side.
const INTAKE_DEFENCE_LOSS = 0.45;

// How far inside the ROBOT STARTING LINE a ROBOT stands at the start. The line is the outer edge of
// the ALLIANCE ZONE, and the engine's BUMPS, TRENCHES and HUB straddle it, so a ROBOT whose BUMPERS
// overlapped the line (what G303-D asks for) would be standing inside the structure in its lane.
// Standing just behind the structure's near face is the closest the geometry here allows.
const START_INSIDE_LINE_IN = 38;
// When two ROBOTs pick the same starting lane they stand this far apart along it instead of on top of
// each other, which is a hair over the 28 in the engine keeps between ROBOTs.
const START_STAGGER_IN = 34;

// Derived arena geometry (§5), mirrored about the CENTER LINE so both ALLIANCES face identical
// distances. X runs red ALLIANCE WALL (0) -> blue ALLIANCE WALL (651.2), Y across (0 -> 317.7).
export const GEO = (() => {
  const L = FIELD.lengthIn;
  const W = FIELD.widthIn;
  const shift = FIELD.hub.centerFromWallIn;
  const bandHalf = FIELD.bump.depthIn / 2;
  const yc = W / 2;
  // Three ROBOTs share one HUB face, and a single shared goal point is a trap: the engine separates
  // ROBOTs inside 28 in, so each one shoves the others off the spot and they loop around it. Every
  // DRIVER STATION therefore gets its own shooting lane, spread laterally and staggered 6 in deeper
  // so the closest pair is 34 in apart. All three stay inside 46 in of the HUB face, which is the
  // alignment the SCORE action tests, and inside 60 in of the HUB centre, which is where shot
  // accuracy stops falling off, so the lane costs nothing.
  const SHOOT_LANE_IN = 34;
  const shootStations = (x, awayFromWall) =>
    [yc - SHOOT_LANE_IN, yc, yc + SHOOT_LANE_IN].map((y, slot) => ({
      x: slot === 1 ? x : x + awayFromWall * 6,
      y,
    }));
  const corridors = () => {
    const out = [];
    for (const dy of [-60, 60]) out.push({ kind: 'bump', y: yc + dy, half: FIELD.bump.widthIn / 2 });
    for (const y of [FIELD.trench.widthIn / 2, W - FIELD.trench.widthIn / 2]) {
      out.push({ kind: 'trench', y, half: FIELD.trench.widthIn / 2 });
    }
    return out;
  };
  return {
    L,
    W,
    yc,
    centerLineX: L / 2,
    hubExitZoneRadiusIn: 44,
    red: {
      allianceZone: [0, FIELD.allianceZoneDepthIn],
      band: [shift - bandHalf, shift + bandHalf],
      hub: { x: shift, y: yc },
      tower: { x: FIELD.tower.baseDepthIn / 2 + 4, y: yc },
      depot: { x: 13.5, y: 110, w: FIELD.depot.depthIn, h: FIELD.depot.widthIn },
      // The OUTPOST's 71 in of frontage carries TWO openings (§5.9.2) and they are laid out side by
      // side here, so the two delivery paths can never be confused for each other:
      //   CORRAL  - the bottom opening, 32.0 x 7.0 in with its floor 1.88 in up, where a ROBOT pushes
      //             FUEL in for its HUMAN PLAYER. 35.8 in wide by 37.6 in deep, so it sits against
      //             the ALLIANCE WALL at the guardrail end.
      //   dump    - the upper opening, 31.8 x 7.0 in with its floor 28.1 in up, which passes FUEL to
      //             the FIELD, so a CHUTE dump lands on open carpet in the other half of the frontage.
      corral: { x: 19, y: 18, w: 37.6, h: 35.8 },
      feed: { x: -16, y: 35 },
      // The HUMAN PLAYER stands behind the ALLIANCE WALL in the OUTPOST AREA (§5.9.2), between the
      // two openings. Keeping it off the FIELD is the whole of its protection: the engine resolves
      // ROBOT contact only between ROBOTs and clamps every ROBOT inside the ALLIANCE WALL, so no
      // ROBOT can reach it (G421).
      human: { x: -16, y: 35 },
      dump: { x: 20, y: 53, w: 36, h: 34 },
      shoot: { x: 118, y: yc },
      shootStations: shootStations(118, -1),
      corridors: corridors(),
      // §5.3 ROBOT STARTING LINE: the line "spans the width of the FIELD at the edge of an ALLIANCE
      // ZONE in front of two BUMPS and an ALLIANCE HUB". The structures it runs in front of are the
      // lanes a ROBOT may start in, and they sit at the same y as the BUMPS and the HUB themselves, so
      // the lane IS the corridor it opens onto. `startX` is as far forward as those structures allow a
      // ROBOT to stand: the engine's BUMPS/TRENCHES/HUB straddle the ALLIANCE ZONE line rather than
      // sitting beyond it, so a ROBOT centred on the line would be inside one.
      startX: shift - START_INSIDE_LINE_IN,
      startLanes: {
        hub: [yc],
        bump: [yc - 60, yc + 60],
        trench: [FIELD.trench.widthIn / 2, W - FIELD.trench.widthIn / 2],
      },
    },
    blue: {
      allianceZone: [L - FIELD.allianceZoneDepthIn, L],
      band: [L - shift - bandHalf, L - shift + bandHalf],
      hub: { x: L - shift, y: yc },
      tower: { x: L - FIELD.tower.baseDepthIn / 2 - 4, y: yc },
      depot: { x: L - 13.5, y: W - 110, w: FIELD.depot.depthIn, h: FIELD.depot.widthIn },
      corral: { x: L - 19, y: W - 18, w: 37.6, h: 35.8 },
      feed: { x: L + 16, y: W - 35 },
      human: { x: L + 16, y: W - 35 },
      dump: { x: L - 20, y: W - 53, w: 36, h: 34 },
      shoot: { x: L - 118, y: yc },
      shootStations: shootStations(L - 118, 1),
      corridors: corridors(),
      startX: L - shift + START_INSIDE_LINE_IN,
      startLanes: {
        hub: [yc],
        bump: [yc - 60, yc + 60],
        trench: [FIELD.trench.widthIn / 2, W - FIELD.trench.widthIn / 2],
      },
    },
  };
})();

export function simulateMatch(opts) {
  const { redAlliance, blueAlliance, redPolicy, bluePolicy, scenario, record = false } = opts;
  const sc = scenario;
  const rng = makeRng((sc.seed >>> 0) ^ 0x9e3779b9);
  const tick = sc.chunkSec;
  const steps = Math.round(TIME.matchSec / tick);
  const decideEvery = Math.max(1, Math.round(0.2 / tick));
  const alliances = { red: redAlliance, blue: blueAlliance };
  const policies = { red: redPolicy, blue: bluePolicy };

  // ---- FUEL store: typed arrays. 504+ discrete FUEL objects updated per tick is the hot loop.
  const total = Math.max(FUEL.stagedTotal, sc.fuelTotal);
  // Minimum spacing a ball keeps from other loose balls, used by the opening layout (neutralLayout)
  // and by every landing (placeLoose). A scenario may set sc.fuelSpacing = 0 to switch the spacing
  // off, which is the control the verifier compares against to show it is what keeps FUEL from
  // stacking.
  const fuelSpacing = sc.fuelSpacing ?? FUEL_SEPARATION_IN;
  const fx = new Float32Array(total);
  const fy = new Float32Array(total);
  const fvx = new Float32Array(total);
  const fvy = new Float32Array(total);
  const ftimer = new Float32Array(total);
  const fscore = new Uint8Array(total);
  const fstate = new Uint8Array(total); // 0 free, 1 chute, 2 corral, 3 held, 4 in flight
  const fholder = new Int16Array(total).fill(-1);
  const fshooter = new Int16Array(total).fill(-1);
  const fhub = new Uint8Array(total); // flight target: 1 red hub, 2 blue hub, 3 a PASS aim point
  // Whether a scored shot was launched legally: 1 = the ROBOT's BUMPERS were inside its ALLIANCE ZONE
  // (G407 / §5.4), 0 = outside, which the HUB's back net stops. Unused for a PASS or an HP throw.
  const flegal = new Uint8Array(total);
  // Where a passed FUEL is aimed. A pass is a launch that is NOT at a HUB, so it carries its own
  // landing point instead of a hub index.
  const fpx = new Float32Array(total);
  const fpy = new Float32Array(total);
  // Where a FUEL in flight was launched from, and who launched it. The replay draws ONE line per
  // shooting ROBOT through the launch points of the balls it has in the air, so a turret firing on the
  // move traces the curve its own path drew instead of a fan of separate dashed spokes to the HUB.
  const fox = new Float32Array(total);
  const foy = new Float32Array(total);
  // FUEL that just bounced off a defender cannot be re-ingested until it has settled, or a ROBOT
  // parked against one would shoot, swallow, and shoot the same ball on a loop that no real driver
  // would keep feeding.
  const fnointake = new Float32Array(total);
  let nointakeActive = 0;
  // Only FUEL that is airborne needs per-tick integration, so keep explicit work lists
  // instead of sweeping all 504+ FUEL every tick.
  const flights = new Set();
  const processing = new Set();

  const pools = { red: { depot: FUEL.perDepot, chute: FUEL.perChute, corral: 0 }, blue: { depot: FUEL.perDepot, chute: FUEL.perChute, corral: 0 } };

  let idx = 0;
  // Two FUEL are balls on the carpet and cannot share a point, so the standing FUEL is laid down on a
  // jittered hexagonal close-packed lattice: cell centres sit at least a ball diameter apart, each
  // ball is nudged a little off its centre, and if the nudge would overlap a neighbour the plain
  // centre is kept. A uniform random scatter cannot hold this many balls - the §6.3.4.1 box is
  // 206 x 72 in for up to 360 FUEL, past the ~55% coverage where random packing jams - so the old
  // rejection sampler fell back to its raw random spot and landed balls on top of each other. The
  // manual calls the NEUTRAL ZONE pile a corral rather than a perfect grid (§6.3.4.1), which the
  // jitter preserves. With sc.fuelSpacing = 0 the lattice is skipped and the balls land uniformly at
  // random, which is the control the verifier compares against.
  //
  // The pile is laid out in POINT-SYMMETRIC PAIRS about the centre of the box, and that is a fix, not a
  // flourish. A row-major lattice is not: its part-filled row sits at one end of the box and its stagger
  // flips with row parity, so the heap is heavier on one ALLIANCE's approach. In a same-trio, same-policy
  // mirror MATCH that showed up as blue taking 57 of 96 AUTOs and 7.7 more AUTO FUEL (63.0 against 70.7),
  // while with sc.fuelSpacing = 0 — an unbiased scatter — the same 96 MATCHes split 46/50. Every mirror
  // number and the "chance of winning AUTO" the page reports inherit that bias, so the lattice now emits
  // ball k together with its 180° partner and the odd ball, if any, at the exact centre.
  function neutralLayout(count, cx, cy, hx, hy) {
    const out = [];
    const scatter = () => {
      for (let k = 0; k < count; k++) out.push({ x: cx + (rng() - 0.5) * hx * 2, y: cy + (rng() - 0.5) * hy * 2 });
    };
    if (count <= 0) return out;
    if (fuelSpacing <= 0) {
      scatter();
      return out;
    }
    const d = FUEL_SEPARATION_IN;
    // An EVEN number of rows is what makes the stagger mirror: row r pairs with row (rows-1-r), and those
    // have opposite parity only when rows is even, so each row's half-cell shift is cancelled by its
    // partner's. Columns are centred on cx and the rows on cy for the same reason.
    let rows = Math.max(2, Math.floor((hy * 2) / ((d * Math.sqrt(3)) / 2)));
    if (rows % 2) rows += 1;
    const cols = Math.max(1, Math.ceil(count / rows));
    const a = (hx * 2) / cols;
    if (a < fuelSpacing) {
      // The box genuinely cannot hold this many balls at this spacing, so a dense heap is honest.
      scatter();
      return out;
    }
    const b = (hy * 2) / rows;
    // The one point that is its own 180° partner is the centre of the box, so an odd count puts its
    // spare ball there — and puts it first, so the pair loop below cannot land a ball on top of it.
    if (count % 2) out.push({ x: cx, y: cy });
    const pairs = [];
    for (let r = 0; r < rows / 2; r++) {
      const yOff = (r - (rows - 1) / 2) * b;
      const stag = r % 2 ? a / 2 : -a / 2;
      for (let c = 0; c < cols; c++) {
        const xOff = (c - (cols - 1) / 2) * a;
        pairs.push({ x: cx + xOff + stag, y: cy + yOff, r: Math.abs(yOff), c: Math.abs(xOff) });
      }
    }
    // Fill from the CENTER outward, so a part-filled box leaves the corners empty rather than one whole
    // side, and the heap stays symmetric in both axes.
    pairs.sort((p, q) => p.r - q.r || p.c - q.c);
    const r = Math.min(0.35, (a - fuelSpacing) / 2);
    const clear = (x, y) => out.every((p) => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) >= fuelSpacing * fuelSpacing);
    for (let k = 0; k < Math.floor(count / 2) && k < pairs.length; k++) {
      const p = pairs[k];
      const q = { x: 2 * cx - p.x, y: 2 * cy - p.y };
      let px = p.x;
      let py = p.y;
      let qx = q.x;
      let qy = q.y;
      // One nudge shared by the pair (+ on one, − on its partner) so the jitter cannot break the
      // symmetry the layout was built for, and both land or neither does.
      for (let t = 0; t < 6 && r > 0.05; t++) {
        const jx = (rng() - 0.5) * 2 * r;
        const jy = (rng() - 0.5) * 2 * r;
        if (clear(p.x + jx, p.y + jy) && clear(q.x - jx, q.y - jy)) {
          px = p.x + jx;
          py = p.y + jy;
          qx = q.x - jx;
          qy = q.y - jy;
          break;
        }
      }
      out.push({ x: px, y: py }, { x: qx, y: qy });
    }
    return out;
  }
  // Each DEPOT holds 24 FUEL resting on the carpet inside the DEPOT (§6.3.4-A). 24 balls of 5.91 in
  // exactly fill a 27 x 42 in DEPOT in a single layer, but NOT on any random scatter — random packing
  // jams near 55% coverage and this is 58% — so the DEPOT is laid out on a 4 x 6 lattice with only a
  // touch of jitter. This is the pile a viewer sees first, and packing it into a corner is what made
  // FUEL look stacked on top of one another.
  for (const side of ['red', 'blue']) {
    const d = GEO[side].depot;
    const cols = 4;
    const rows = Math.ceil(FUEL.perDepot / cols);
    const sx = d.w / cols;
    const sy = d.h / rows;
    for (let k = 0; k < FUEL.perDepot; k++, idx++) {
      fstate[idx] = 0;
      const col = k % cols;
      const row = Math.floor(k / cols);
      fx[idx] = d.x - d.w / 2 + sx / 2 + col * sx + (rng() - 0.5) * 0.6;
      fy[idx] = d.y - d.h / 2 + sy / 2 + row * sy + (rng() - 0.5) * 0.6;
    }
  }
  // Each OUTPOST CHUTE starts with 24 FUEL staged off-FIELD (§6.3.4-B): only a HUMAN PLAYER
  // can enter them onto the FIELD (G425).
  for (const side of ['red', 'blue']) {
    const f = GEO[side].feed;
    for (let k = 0; k < FUEL.perChute; k++, idx++) {
      fstate[idx] = 1;
      fx[idx] = f.x;
      fy[idx] = f.y;
    }
  }

  // Starting positions, from each ROBOT's own setting (§5.3 / G303-D). 'auto' gives the three DRIVER
  // STATIONS the three structures the ROBOT STARTING LINE runs in front of — a BUMP, the HUB, the
  // other BUMP — and an explicit choice moves that ROBOT into the lane it asked for. A second ROBOT
  // in the same lane is staggered along it, so the opening frame never has two cars on one spot.
  const startSpots = { red: [], blue: [] };
  for (const side of ['red', 'blue']) {
    const g = GEO[side];
    const taken = { hub: 0, bump: 0, trench: 0 };
    alliances[side].robots.forEach((r, slot) => {
      const kind = r.start === 'bump' || r.start === 'trench' || r.start === 'hub' ? r.start : slot === 1 ? 'hub' : 'bump';
      const n = taken[kind];
      taken[kind] += 1;
      const lanes = g.startLanes[kind];
      const lane = n < lanes.length ? lanes[n] : lanes[lanes.length - 1] + (n - lanes.length + 1) * START_STAGGER_IN;
      startSpots[side].push({ x: g.startX, y: clamp(lane, 20, GEO.W - 20) });
    });
  }

  const robots = [];
  for (const side of ['red', 'blue']) {
    alliances[side].robots.forEach((r, slot) => {
      robots.push({
        ...r,
        alliance: side,
        slot,
        idx: robots.length,
        x: startSpots[side][slot].x,
        y: startSpots[side][slot].y,
        vx: 0,
        vy: 0,
        // Which way the ROBOT faces, in radians, and the unit vector the directional intake reads. The
        // heading is real state now, not a read-out of the velocity: a square ROBOT has a front, a
        // Dumper's shooter is bolted to it, and a TANK drive cannot travel anywhere except along it. Red
        // opens facing the FIELD, blue facing back.
        heading: side === 'red' ? 0 : Math.PI,
        hx: side === 'red' ? 1 : -1,
        hy: 0,
        // The intake mouth is not necessarily on the front face. This is its bearing from the heading in
        // degrees, and ix/iy the unit vector it faces. With a front intake they are hx/hy and nothing
        // changes; with a rear one the mouth faces backwards, so the ROBOT has to drive out of a pile to
        // sweep it and the mouth has to be the end that arrives first.
        intakeOffsetDeg: (r.derived && r.derived.intakeOffsetDeg) || 0,
        ix: side === 'red' ? 1 : -1,
        iy: 0,
        // Signed spin rate in deg/s, integrated toward the commanded turn under turnAccelDegPerSec2.
        // Keeping it as state is what makes a turn a trapezoid: a drivetrain has to build the spin up
        // against the carpet and bleed it off again, so it cannot reverse direction inside one tick.
        turnVel: 0,
        carrying: 0,
        intent: { mode: INTENT.IDLE },
        // `climb` merges the ROBOT's climb capabilities (l1/l2/l3, timeSec, attachTimeSec) with
        // this MATCH's runtime climb state.
        climb: { ...r.climb, level: 0, progress: 0, attaching: false, attachClock: 0, dismountLeft: 0, done: false, autoLevel: 0 },
        health: 1,
        disabled: false,
        // Set by a damaging contact (G415/G416/G417): capability drops for CONTACT_IMPAIR_SEC and then
        // returns. `contactCooldown` keeps one collision from being adjudicated on several ticks, and
        // `contactFouls` counts this ROBOT's own contacts, which is how G417's "CONTINUOUS" and the
        // rules' REPEATED escalation to a RED CARD are recognised.
        impairLeft: 0,
        impairFactor: 1,
        contactCooldown: 0,
        contactFouls: 0,
        defensePressure: 0,
        pinTimer: 0,
        g408Timer: 0,
        g408Instances: 0,
        g420Cooldown: 0,
        shootClock: 0,
        aimClock: 0,
        passClock: 0,
        depositClock: 0,
        distance: 0,
        stat: {
          fuelCollected: 0,
          fuelScored: 0,
          fuelWasted: 0,
          fuelDelivered: 0,
          // The part of `fuelDelivered` that came from shoving a LOOSE FUEL through the CORRAL opening
          // while driving past it, rather than from a ROBOT that was asked to FEED. Both are legal play
          // (§5.9.2 puts no intent requirement on the bottom opening, and G427 only caps how much may be
          // stored), but they are different mechanisms, and the verifier has to be able to tell a wall
          // leak from the action it is testing.
          fuelPushedIn: 0,
          fouls: 0,
          foulPointsGiven: 0,
          pins: 0,
          // Seconds this ROBOT spent functionally impaired by an opponent's contact (G415/G416/G417).
          impairedSec: 0,
          blockedByOpponentSec: 0,
          climbLevel: 0,
          climbPoints: 0,
          activeSec: 0,
          // Ticks with the rollers running (sweep(), which the SCORE and PASS actions also call) and
          // how many of those actually swallowed FUEL. Not SCOUTING data — a diagnostic for the
          // throughput probe, which is why the two are counters and not a rate.
          collectTicks: 0,
          intakeTicks: 0,
          // Defence's physical outcome: launches this ROBOT lost to a body in the lane, and launches
          // it stopped by standing in one.
          shotsBlocked: 0,
          blocks: 0,
          // Launches that left the hopper while the ROBOT's BUMPERS were outside its own ALLIANCE ZONE
          // (§5.4 / G407). The gate refuses them, so this stays 0 and the verifier pins it there.
          outOfZoneShots: 0,
        },
      });
    });
  }

  // Every per-ROBOT pass in the tick below walks this array in build order, and build order is red's
  // three machines first. On a FUEL both alliances could take this tick, and on the 0.2 s decision pass
  // where whichever side picks a pile first keeps it, that is a first-mover advantage: in a same-roster
  // mirror MATCH it measured +18.3 +- 4.6 points to red. Serving the ALLIANCES in alternating order,
  // swapping every tick, is what makes a mirror MATCH actually symmetric.
  const serveOrder = [robots, robots.filter((r) => r.alliance === 'blue').concat(robots.filter((r) => r.alliance === 'red'))];

  // Preload (§6.3.4-C, capped by G303-I): each ROBOT may start supporting up to 8 FUEL.
  for (const rb of robots) {
    const pre = Math.min(FUEL.maxPreloadPerRobot, rb.capacity);
    rb.carrying = pre;
    for (let k = 0; k < pre && idx < total; k++, idx++) {
      fstate[idx] = 3;
      fholder[idx] = rb.idx;
    }
  }
  // Remaining FUEL starts in the NEUTRAL ZONE inside the §6.3.4.1 box straddling the CENTER LINE.
  const box = FUEL.neutralView;
  const neutral = neutralLayout(
    total - idx,
    GEO.centerLineX,
    GEO.yc,
    box.depthIn / 2 - FUEL_RADIUS_IN,
    box.widthIn / 2 - FUEL_RADIUS_IN,
  );
  for (let k = 0; idx < total; k++, idx++) {
    fstate[idx] = 0;
    fx[idx] = neutral[k].x;
    fy[idx] = neutral[k].y;
  }

  if (sc.faultsEnabled) {
    for (const rb of robots) {
      if (rng() > rb.reliability) {
        rb.fault = { at: rng.range(25, TIME.matchSec - 25), hard: rng.chance(0.18), done: false };
      }
    }
  }

  const score = {
    red: { fuel: 0, fuelInactive: 0, towerAuto: 0, towerTeleop: 0, foulPoints: 0 },
    blue: { fuel: 0, fuelInactive: 0, towerAuto: 0, towerTeleop: 0, foulPoints: 0 },
  };
  const autoFuel = { red: 0, blue: 0 };
  const events = [];
  const timeline = [];
  let autoWinner = null;
  let hubSchedule = null;
  let period = 'AUTO';
  const blockState = { red: 0, blue: 0 };

  // ---- HUMAN PLAYER actors (§6.1, §5.9.2) ----
  // One per ALLIANCE, at its OUTPOST. The HP is not a ROBOT and has no position the motion solver
  // touches, so nothing can collide with it. `action` is only what the replay draws; `door` is the
  // continuous CHUTE DOOR angle (0 shut .. 1 open) and everything else is the HP's own clockwork.
  const newHuman = (side) => ({
    side,
    hand: 0,
    door: 0,
    throwClock: 0,
    dumpAcc: 0,
    fullStoreSec: 0,
    action: 'HOLD',
    stat: { throws: 0, hits: 0, dumped: 0 },
  });
  const hps = { red: newHuman('red'), blue: newHuman('blue') };
  // What the policy asked this HP to do, refreshed with the ROBOT decisions.
  const humanCmd = { red: 'HOLD', blue: 'HOLD' };
  // `c`/`r` are what is still staged at the OUTPOST (CHUTE and CORRAL). The replay shows the HP's
  // total stock, not just the two FUEL in its hand, because the stock is the FUEL it can still throw.
  const hpSnap = (hp, side) => ({
    a: hp.action,
    d: hp.door > 0.5 ? 1 : 0,
    h: hp.hand,
    c: pools[side].chute,
    r: pools[side].corral,
    x: hp.stat.throws,
    s: hp.stat.hits,
  });
  // §5.4: a HUB returns FUEL to the NEUTRAL ZONE through four exits, and that return path has a
  // finite throughput. It is what sets the tempo of the whole MATCH: the FIELD only holds 504 FUEL
  // (§6.3.4), so a HUB that recirculates instantly lets an ALLIANCE re-score the same FUEL over and
  // over with nothing to stop it. See hubExitRate in defaultScenario() for the calibration.
  const hubExitRate = sc.hubExitRate ?? defaultScenario().hubExitRate;
  const exitAcc = { red: 0, blue: 0 };

  const log = (t, kind, data) => {
    if (events.length < 3000) events.push({ t: +t.toFixed(2), kind, ...data });
  };
  const hubActive = (side, t) => {
    if (t < TIME.autoSec + TIME.transitionSec) return true;
    if (!hubSchedule) return true;
    const p = periodAt(t);
    const row = hubSchedule.find((r) => r.period === p);
    return row ? row[side] : true;
  };
  // `offendingSide` is the ALLIANCE being charged: Table 6-6 hands the points to its opponent, and
  // `e.against` in the event log reads "assessed against" in the same sense. The ROBOT passed as `rb`
  // is the one that committed it, so a foul can be traced to a machine and not just a wall colour.
  const awardFoul = (offendingSide, points, reason, t, rb) => {
    score[other(offendingSide)].foulPoints += points;
    log(t, 'foul', { against: offendingSide, points, reason, robot: rb ? rb.idx : null });
    if (rb) {
      rb.stat.fouls += 1;
      rb.stat.foulPointsGiven += points;
    }
  };

  const usableCorridors = (side, rb) =>
    GEO[side].corridors.filter((c) => (c.kind === 'bump' ? rb.canBump : rb.canTrench));

  // A TOWER is 49.25 in wide with the UPRIGHTS 32.25 in apart (§5.8), so up to three ROBOTS
  // share the face. Giving each ROBOT its own lane keeps them from shoving each other off it
  // (and ALLIANCE partners may not support each other, G414).
  const climbSpotFor = (rb) => ({ x: GEO[rb.alliance].tower.x, y: GEO[rb.alliance].tower.y + (rb.slot - 1) * 17 });

  // Where a ROBOT stages to hand FUEL to its HUMAN PLAYER: in front of the CORRAL's opening in the
  // OUTPOST's FIELD-facing wall, offset far enough out that its BUMPERS stay clear of the bin.
  const corralMouth = (side) => {
    const c = GEO[side].corral;
    return { x: c.x + (side === 'red' ? 1 : -1) * (c.w / 2 + 14), y: c.y };
  };

  // Route movement through a legal corridor when a ROBOT has to cross the BUMP/TRENCH band.
  // The corridor choice is committed until the crossing is done: re-deciding it every tick makes
  // a ROBOT dither in Y whenever its goal moves, because candidate corridors sit far apart in Y.
  function navTarget(rb, tx, ty) {
    const band = GEO[rb.alliance].band;
    const outside = rb.x < band[0] || rb.x > band[1];
    const crossing = (rb.x < band[0] && tx > band[1]) || (rb.x > band[1] && tx < band[0]);
    if (!crossing) {
      rb.navCorridor = null;
      return { x: tx, y: ty };
    }
    const cors = usableCorridors(rb.alliance, rb);
    // A ROBOT built so it can clear neither a BUMP nor a TRENCH is confined to its own side of the
    // band; holding it at the band edge is the honest outcome, and it keeps the loop below from
    // dereferencing an empty corridor list.
    if (!cors.length) {
      rb.navCorridor = null;
      return { x: outside ? (rb.x < band[0] ? band[0] - 4 : band[1] + 4) : tx, y: ty };
    }
    let best = null;
    if (rb.navCorridor != null) best = cors.find((c) => c.y === rb.navCorridor) || null;
    if (!best) {
      best = cors[0];
      let bestCost = Infinity;
      for (const c of cors) {
        const cost = Math.abs(rb.y - c.y) + 0.6 * Math.abs(ty - c.y) + (c.kind === 'trench' ? 0 : 5);
        if (cost < bestCost) {
          bestCost = cost;
          best = c;
        }
      }
      rb.navCorridor = best.y;
    }
    if (outside && Math.abs(rb.y - best.y) > 7) return { x: rb.x, y: best.y };
    if (outside) return { x: rb.x < band[0] ? band[1] + 4 : band[0] - 4, y: best.y };
    return { x: tx, y: ty };
  }

  const solids = [];
  for (const side of ['red', 'blue']) {
    const g = GEO[side];
    solids.push({ x: g.hub.x, y: g.hub.y, hw: FIELD.hub.sizeIn / 2, hh: FIELD.hub.sizeIn / 2 });
    solids.push({ x: g.tower.x, y: g.tower.y, hw: FIELD.tower.baseDepthIn / 2, hh: FIELD.tower.baseWidthIn / 2 });
    for (const c of g.corridors) {
      if (c.kind === 'bump') solids.push({ x: g.hub.x, y: c.y, hw: FIELD.bump.depthIn / 2, hh: c.half, bump: true });
    }
  }
  function obstacleResolve(rb) {
    for (const s of solids) {
      if (s.bump) continue; // a BUMP is driven over, not around (§5.5)
      const dx = rb.x - s.x;
      const dy = rb.y - s.y;
      const ox = s.hw + 12 - Math.abs(dx);
      const oy = s.hh + 12 - Math.abs(dy);
      if (ox > 0 && oy > 0) {
        if (ox < oy) rb.x += Math.sign(dx || 1) * ox;
        else rb.y += Math.sign(dy || 1) * oy;
      }
    }
    rb.x = clamp(rb.x, 6, GEO.L - 6);
    rb.y = clamp(rb.y, 6, GEO.W - 6);
  }

  const cell = 40;
  const gw = Math.ceil(GEO.L / cell);
  const gh = Math.ceil(GEO.W / cell);
  let grid = new Array(gw * gh).fill(null);
  function rebuildGrid() {
    grid = new Array(gw * gh).fill(null);
    for (let i = 0; i < total; i++) {
      if (fstate[i] !== 0) continue;
      const cx = clamp(Math.floor(fx[i] / cell), 0, gw - 1);
      const cy = clamp(Math.floor(fy[i] / cell), 0, gh - 1);
      const k = cx * gh + cy;
      (grid[k] || (grid[k] = [])).push(i);
    }
  }
  // Two FUEL are balls on the carpet and cannot share a point, but every landing in the engine is an
  // independent random draw — a HUB exit, a CHUTE dump, a shot coming down — so balls did land stacked
  // on one another, which read as a rendering bug and let a single sweep take two off the same inch.
  // Every landing goes through here: expel from any structure the ball came down inside, then nudge
  // it off any loose ball it would overlap, along a few random directions. If a spot is genuinely
  // crowded the ball still lands (stacked) rather than vanishing, because FUEL must never be lost by
  // the placement code. This is a placement fix, not a continuous separation pass: it does not stir
  // piles that the match itself built, which would change how the whole FIELD plays.
  function placeLoose(i, x, y) {
    const land = expelFromSolid(x, y, FUEL_RADIUS_IN);
    if (fuelSpacing <= 0) return land;
    let px = land.x;
    let py = land.y;
    for (let attempt = 0; attempt < 5; attempt++) {
      let clash = false;
      for (let k = 0; k < total; k++) {
        if (k === i || fstate[k] !== 0) continue;
        const dx = px - fx[k];
        const dy = py - fy[k];
        if (dx * dx + dy * dy < fuelSpacing * fuelSpacing) {
          clash = true;
          break;
        }
      }
      if (!clash) break;
      const a = rng() * Math.PI * 2;
      const nx = clamp(land.x + Math.cos(a) * fuelSpacing, 8, GEO.L - 8);
      const ny = clamp(land.y + Math.sin(a) * fuelSpacing, 8, GEO.W - 8);
      if (solidBlocked(nx, ny, FUEL_RADIUS_IN)) continue;
      px = nx;
      py = ny;
    }
    return { x: px, y: py };
  }
  // The rollers are a separate mechanism from the shooter, so sweeping FUEL and putting a FUEL out
  // are not exclusive: a ROBOT dumping at its HUB lane keeps collecting whatever it is sitting on,
  // and so does one lobbing a PASS to a partner. Everything unique to a roller intake lives here —
  // the speed falloff, the mouth's face gate, the defence loss and the G408 HUB-exit bookkeeping — so the
  // three actions that sweep cannot drift apart.
  function sweep(rb, t) {
    rb.stat.collectTicks += 1;
    // A roller intake cannot swallow FUEL at a full sprint — teams slow down to sweep — so the usable
    // rate falls off with ground speed instead of being the same at a crawl and at 14 ft/s. This is
    // the single biggest gap between a 1-D kinematic cycle and a real one.
    const droop = 1 - 0.6 * clamp((Math.hypot(rb.vx, rb.vy) - 55) / 90, 0, 1);
    // Defence has to touch the intake as well, or it accomplishes nothing: an opponent with its
    // BUMPERS in your intake mouth stops you sweeping FUEL at all. Drive speed, shoot rate and
    // accuracy are already scaled by defencePressure; leaving intake untouched made defending
    // strictly self-harming (measure: 1 defender cost 200 own points and did not reduce the
    // opponent's score at all).
    const press = 1 - INTAKE_DEFENCE_LOSS * rb.defensePressure;
    const reach = sc.intakeReach ?? MOUTH_REACH_IN;
    if (takeFuelNear(rb, 14, rb.intakeRate * capability(rb) * droop * press, tick, reach) > 0) rb.stat.intakeTicks += 1;
    // G408: FUEL released by a HUB may not be caught or redirected beyond MOMENTARY CONTROL.
    let nearExit = false;
    for (const side of ['red', 'blue']) {
      const h = GEO[side].hub;
      const ex = h.x + (side === 'red' ? FIELD.hub.sizeIn / 2 : -FIELD.hub.sizeIn / 2);
      if (Math.hypot(rb.x - ex, rb.y - h.y) < GEO.hubExitZoneRadiusIn) nearExit = true;
    }
    if (nearExit && rb.carrying < rb.capacity) {
      const prev = rb.g408Timer;
      rb.g408Timer += tick;
      if (prev <= 3 && rb.g408Timer > 3) {
        awardFoul(rb.alliance, POINTS.foul.minor, 'G408 catching FUEL at a HUB exit', t, rb);
        rb.g408Instances += 1;
      } else if (rb.g408Timer > 6 && Math.floor((rb.g408Timer - 6) / 3) > Math.floor((prev - 6) / 3)) {
        awardFoul(rb.alliance, POINTS.foul.major, 'G408 strategic FUEL catching', t, rb);
        rb.g408Instances += 1;
      }
    } else rb.g408Timer = Math.max(0, rb.g408Timer - tick * 1.5);
  }

  // Is an offset from the ROBOT's centre inside the band its intake mouth sweeps? The mouth is the
  // whole face: it spans the car from bumper to bumper, and it grabs everything within `reach` of the
  // face line. One test answers both questions that depend on it — "the roller eats this FUEL" and
  // "this FUEL is being shoveled past a roller that is switched on" — so they cannot drift apart.
  function inMouth(rb, dx, dy, reach) {
    const half = footprintHalf(rb);
    const along = dx * rb.ix + dy * rb.iy;
    const across = Math.abs(-dx * rb.iy + dy * rb.ix);
    return Math.hypot(Math.abs(along - half), Math.max(0, across - half)) <= reach;
  }

  function takeFuelNear(rb, radius, rate, dt, mouthReach = 0) {
    // Accumulate fractionally so intakeRate is a true FUEL/s limit rather than 1 FUEL/tick.
    rb.intakeAcc = Math.min(2, (rb.intakeAcc || 0) + rate * dt);
    const budget = Math.floor(rb.intakeAcc);
    if (budget <= 0 || rb.carrying >= rb.capacity) return 0;
    const cap = Math.min(budget, rb.capacity - rb.carrying);
    const rc = clamp(Math.floor(rb.x / cell), 0, gw - 1);
    const ry = clamp(Math.floor(rb.y / cell), 0, gh - 1);
    let got = 0;
    for (let ax = rc - 1; ax <= rc + 1; ax++) {
      for (let ay = ry - 1; ay <= ry + 1; ay++) {
        if (ax < 0 || ay < 0 || ax >= gw || ay >= gh) continue;
        const bucket = grid[ax * gh + ay];
        if (!bucket) continue;
        for (const i of bucket) {
          if (fstate[i] !== 0) continue;
          if (fnointake[i] > 0) continue;
          const dx = fx[i] - rb.x;
          const dy = fy[i] - rb.y;
          if (dx * dx + dy * dy > radius * radius) continue;
          // An intake is a mouth on one face of the ROBOT, not a radial vacuum. mouthReach <= 0 keeps
          // the old omnidirectional behaviour, which is what a ROBOT with no roller deployed does.
          if (mouthReach > 0) {
            const d = Math.hypot(dx, dy);
            // FUEL already in contact with the rollers is ingested whatever the ROBOT is facing.
            // Without this a ROBOT that parks exactly on a FUEL reads a zero-length bearing and can
            // never pick it up again.
            if (d > 12 && !inMouth(rb, dx, dy, mouthReach)) continue;
          }
          fstate[i] = 3;
          fholder[i] = rb.idx;
          rb.carrying += 1;
          got += 1;
          rb.stat.fuelCollected += 1;
          if (got >= cap) {
            rb.intakeAcc -= got;
            rebuildHint();
            return got;
          }
        }
      }
    }
    rb.intakeAcc -= got;
    if (got > 0) rebuildHint();
    return got;
  }

  // FUEL taken out of the grid leaves stale entries behind; flag for a rebuild when it matters.
  let gridDirty = 0;
  const rebuildHint = () => {
    gridDirty += 1;
  };

  // Loose FUEL is not scenery. A ROBOT driving into it shoves it along — "bulldozing" — which is both how
  // FUEL actually ends up rearranged across a MATCH and a real, if slow, way to move FUEL out of the
  // far half and toward your own. It also means a sweep that misses the intake mouth does not leave
  // the pile untouched.
  //
  // FUEL must not be pushed INSIDE a structure, though. A pile buried in a TOWER can never be
  // collected, and because both the AI and the greedy baseline simply target the nearest loose FUEL,
  // one such ball is enough to keep a whole ROBOT — and with it the ALLIANCE's game — pinned against
  // the structure for the rest of the MATCH.
  function solidBlocked(x, y, r) {
    for (const s of solids) {
      if (s.bump) continue; // a BUMP is driven over (§5.5), so FUEL rolls onto it
      if (Math.abs(x - s.x) < s.hw + r && Math.abs(y - s.y) < s.hh + r) return true;
    }
    return false;
  }

  // The escape hatch for FUEL that is already inside a structure (a PASS aimed into one, say): push
  // it out along the shortest way, the same rule obstacleResolve applies to a ROBOT.
  function expelFromSolid(x, y, r) {
    for (let k = 0; k < 4; k++) {
      let hit = null;
      for (const s of solids) {
        if (s.bump) continue;
        if (Math.abs(x - s.x) < s.hw + r && Math.abs(y - s.y) < s.hh + r) {
          hit = s;
          break;
        }
      }
      if (!hit) break;
      const dx = x - hit.x;
      const dy = y - hit.y;
      const ox = hit.hw + r - Math.abs(dx);
      const oy = hit.hh + r - Math.abs(dy);
      if (ox < oy) x += Math.sign(dx || 1) * ox;
      else y += Math.sign(dy || 1) * oy;
    }
    return { x: clamp(x, 8, GEO.L - 8), y: clamp(y, 8, GEO.W - 8) };
  }

  // §5.9.2: the CORRAL's bottom opening is where "ROBOTs can push FUEL into the CORRAL", and the
  // OUTPOST exists so that "ROBOTS can deliver FUEL to their HUMAN PLAYERS" — a ball pushed in leaves
  // the FIELD and joins the stored pool the HP throws from, and a full bin refuses it, which is what
  // makes the G427 storage limit real rather than a number the engine merely declares.
  //
  // The gate is the OPENING, not the footprint. §5.9.2 puts the CORRAL behind a single 32.0 x 7.0 in
  // slot in the OUTPOST's FIELD-facing wall, so a ball counts as delivered only if it crosses that
  // plane into the bin. Testing the footprint instead would swallow anything that drifts along the
  // ALLIANCE WALL, which is where a ROBOT sweeping its own DEPOT pushes FUEL — a team would end up
  // feeding its OUTPOST by accident and losing the FUEL to a slow scorer.
  function enteredCorral(side, x0, y0, x1, y1) {
    const c = GEO[side].corral;
    const front = side === 'red' ? c.x + c.w / 2 : c.x - c.w / 2;
    const inward = side === 'red' ? x0 >= front && x1 < front : x0 <= front && x1 > front;
    return inward && Math.abs(y1 - c.y) <= c.h / 2;
  }
  // Stored FUEL carries no useful position — it is inside a bin off the FIELD — so the whole pool
  // sits on the bin's centre. Nothing draws it (sampleFuel records the FIELD only), and a ROBOT
  // cannot take it back out: a delivery hands the FUEL to the HUMAN PLAYER.
  function storeInCorral(i, side) {
    const c = GEO[side].corral;
    fstate[i] = 2;
    fholder[i] = -1;
    fx[i] = c.x;
    fy[i] = c.y;
    pools[side].corral += 1;
  }

  function bulldoze(rb) {
    if (rb.pushMode === 'off') return;
    const sp = Math.hypot(rb.vx, rb.vy);
    if (sp < 20) return;
    // Whether the roller is actually turning this tick. FUEL sitting in the mouth belongs to the intake
    // rather than to the BUMPER, but only while something is there to swallow it: PUSH, DEFEND and FEED
    // all leave the roller off, and exempting the mouth on geometry alone meant a pusher driving head-on
    // at a pile could neither take the ball nor shove it — it just rolled under the car.
    const m0 = rb.intent.mode;
    const rollerOn = m0 === INTENT.COLLECT || m0 === INTENT.STOCKPILE || m0 === INTENT.SCORE || m0 === INTENT.PASS;
    const rc = clamp(Math.floor(rb.x / cell), 0, gw - 1);
    const ry = clamp(Math.floor(rb.y / cell), 0, gh - 1);
    let moved = false;
    for (let ax = rc - 1; ax <= rc + 1; ax++) {
      for (let ay = ry - 1; ay <= ry + 1; ay++) {
        if (ax < 0 || ay < 0 || ax >= gw || ay >= gh) continue;
        const bucket = grid[ax * gh + ay];
        if (!bucket) continue;
        for (const i of bucket) {
          if (fstate[i] !== 0) continue;
          const dx = fx[i] - rb.x;
          const dy = fy[i] - rb.y;
          const d = Math.hypot(dx, dy);
          if (d > 22 || d < 1e-6) continue;
          if (rollerOn && d <= 14 && inMouth(rb, dx, dy, sc.intakeReach ?? MOUTH_REACH_IN)) continue;
          const push = sp * tick * (sc.bulldoze ?? BULLDOZE_FACTOR);
          const nx = clamp(fx[i] + (dx / d) * push, 8, GEO.L - 8);
          const ny = clamp(fy[i] + (dy / d) * push, 8, GEO.W - 8);
          if (solidBlocked(nx, ny, FUEL_RADIUS_IN)) continue;
          if (enteredCorral(rb.alliance, fx[i], fy[i], nx, ny)) {
            if (pools[rb.alliance].corral < FUEL.corralCapacity) {
              storeInCorral(i, rb.alliance);
              rb.stat.fuelDelivered += 1;
              rb.stat.fuelPushedIn += 1;
              moved = true;
            }
            // A full CORRAL refuses the ball, so it stays on the carpet where it was.
            continue;
          }
          fx[i] = nx;
          fy[i] = ny;
          moved = true;
        }
      }
    }
    if (moved) rebuildHint();
  }

  function releaseShot(rb) {
    const hub = GEO[rb.alliance].hub;
    const zone = GEO[rb.alliance].allianceZone;
    const legal = rb.x >= zone[0] && rb.x <= zone[1];
    const dist = Math.hypot(rb.x - hub.x, rb.y - hub.y);
    let acc = rb.shootAccuracy - rb.accuracyFalloff * Math.max(0, dist - rb.refShootDistanceIn);
    // Defence suppresses a cycle far more than drive speed alone suggests: a bumper in your face
    // slows you down AND costs you shots, which is why real MATCH scores land well under an
    // undefended simulation.
    acc *= 1 - 0.5 * rb.defensePressure;
    acc = clamp(acc, 0.08, 0.99);
    for (let i = 0; i < total; i++) {
      if (fstate[i] === 3 && fholder[i] === rb.idx) {
        fstate[i] = 4;
        fholder[i] = -1;
        fshooter[i] = rb.idx;
        ftimer[i] = 0.55;
        fhub[i] = rb.alliance === 'red' ? 1 : 2;
        flegal[i] = legal ? 1 : 0;
        fscore[i] = rng() < acc ? 1 : 0;
        fvx[i] = (hub.x - rb.x) / 0.55;
        fvy[i] = (hub.y - rb.y) / 0.55;
        fox[i] = rb.x;
        foy[i] = rb.y;
        // The gate in fireAtHub refuses an out-of-zone launch, so this can only be non-zero if the gate
        // and the net backstop are both gone. Counting it anyway is what makes the §5.4 check in
        // scripts/verify.mjs a statement about where shots are launched from rather than about how many
        // points a ROBOT happened to score while it was driving around.
        if (!legal) rb.stat.outOfZoneShots += 1;
        rb.carrying -= 1;
        flights.add(i);
        return i;
      }
    }
    return -1;
  }

  // The shot gate. Split out of the SCORE action because a turret also fires while it is doing something
  // else (see COLLECT below), and one gate means the two cannot drift apart on legality or on rate.
  //
  // §5.4: "A net structure located in the back of the HUB prevents FUEL launched from most prohibited
  // areas from entering the opening." The prohibited areas are outside your own ALLIANCE ZONE, and the
  // HUB sits exactly on the zone line, so a ROBOT firing at its own HUB from the wrong side would hit
  // that net. The engine enforces the net where it is cheapest and most honest: the launch itself is
  // refused, so the shot never leaves the hopper and the ROBOT keeps its load and drives back in (the
  // policy's SCORE target is what brings it home). The referee's MAJOR FOUL for this (G407) is not
  // awarded, because the engine never lets the violation happen. resolveFlight carries the matching
  // backstop for a shot that is already in the air, so the invariant holds even if a future policy
  // fires from outside the zone.
  function fireAtHub(rb, g) {
    const inZone = rb.x >= g.allianceZone[0] && rb.x <= g.allianceZone[1];
    const isTurret = rb.mechanism === 'turret';
    // A turret slews onto the HUB, so it needs no lane: it fires from where it stands. A full-width
    // Dumper has to be at the HUB face, inside the alignment circle the AI's own firing-spot search
    // uses (policy.js ALIGN_RADIUS_IN).
    const aligned = isTurret || Math.hypot(rb.x - g.shoot.x, rb.y - g.shoot.y) < DUMPER_ALIGN_IN;
    // Reaching the HUB face is not the whole of it for a Dumper: its shooter is bolted to ONE face of
    // the square, so that face has to be turned onto the goal before the hopper can leave. A turret
    // slews independently of the chassis and is exempt. This is the constraint that makes a heading
    // worth carrying at all - without it a square ROBOT has no front and "one side only" says nothing.
    // The motion code drives the heading onto the HUB whenever the intent is SCORE, so a Dumper pays
    // its turn time before its spin-up rather than instead of it, and a TANK drive pays it twice over
    // because turning at speed costs it nearly half its turn rate. sc.dumperFaceTolDeg overrides the
    // tolerance (180 switches the constraint off) so its cost can be measured against a control.
    const faceTol = sc.dumperFaceTolDeg ?? DUMPER_FACE_TOL_DEG;
    const faceOn =
      isTurret ||
      Math.abs(angleDeltaDeg(bearingDeg(g.hub.x - rb.x, g.hub.y - rb.y), rb.heading / DEG)) <= faceTol;
    // Like `bulldoze` and `hubExitRate`, a scenario may override the aim pair so the mechanism trade can
    // be measured on its own (scripts/probe.mjs) and pinned by the verifier. The DRIVER's aim time
    // scales the mechanism's own spin-up (see DRIVERS in model.js): a TURRET slews about 6 times faster
    // than a DUMPER's whole-hopper spin-up, and a better driver shaves a fixed fraction off whichever
    // they have.
    const aimSec =
      (isTurret ? (sc.turretAimSec ?? TURRET_AIM_SEC) : (sc.dumperAimSec ?? DUMPER_AIM_SEC)) * (rb.aimFactor ?? 1);
    if (inZone && aligned && faceOn && rb.carrying > 0) {
      rb.aimClock = (rb.aimClock || 0) + tick;
      if (rb.aimClock >= aimSec) {
        rb.shootClock += tick;
        const interval = 1 / Math.max(0.4, rb.shootRate * capability(rb) * (1 - 0.5 * rb.defensePressure));
        while (rb.shootClock >= interval && rb.carrying > 0) {
          rb.shootClock -= interval;
          releaseShot(rb);
        }
      }
    } else {
      rb.shootClock = 0;
      rb.aimClock = 0;
    }
  }

  // A turret does not have to be under SCORE to shoot: its shooter slews independently of the
  // drivetrain, so it can keep the rollers running and fire at the same time. That is the mechanism's
  // real advantage over a full-width Dumper, which has to park and square up, and it is why a turret's
  // cycle has no aim leg in it at all. Held to the range where the shot is still worth taking - the
  // profile's own reference distance plus a margin - so a turret crossing its zone does not empty the
  // hopper across the whole FIELD at the falloff end of the accuracy curve.
  //
  // It also only fires while its own HUB is live. This shot is the ENGINE's initiative, not a play the
  // policy asked for, so it has to clear a bar the policy's own SCORE does not: during an INACTIVE
  // window the policy is banking a load for the SHIFT that opens next, and an opportunistic shot
  // empties that bank for 0 points and hands the FUEL to midfield. A policy that deliberately dumps
  // into a dead HUB is a different thing - that is a choice, it is legal, and §5.4 still moves the
  // ball through the HUB and out into the NEUTRAL ZONE - so fireAtHub itself stays ungated and the
  // greedy baseline keeps its defining habit.
  function turretOpportunityFire(rb, g, t) {
    if (rb.mechanism !== 'turret' || rb.carrying <= 0) return;
    const margin = sc.turretOpportunityMarginIn ?? TURRET_OPPORTUNITY_MARGIN_IN;
    if (margin <= 0) return; // the control: a turret that only shoots under an explicit SCORE
    // sc.turretFireInDarkWindow restores the pre-fix behaviour so the gate's worth can be measured
    // against a control instead of asserted.
    if (!hubActive(rb.alliance, t) && !sc.turretFireInDarkWindow) return;
    if (Math.hypot(rb.x - g.hub.x, rb.y - g.hub.y) > rb.refShootDistanceIn + margin) return;
    fireAtHub(rb, g);
  }

  // A PASS releases FUEL toward an aim point instead of at the HUB. It reuses the ROBOT's shooter, so
  // it leaves at the same rate a scoring shot does, but it can be thrown from anywhere on the FIELD:
  // G407 ("Only score while in your ALLIANCE ZONE", TU21 p.65) only governs a launch INTO the HUB, and
  // a pass is aimed away from one, so that clause does not reach it. The clauses that DO reach a pass
  // are G404 (never deliberately launch a SCORING ELEMENT at an opponent ROBOT, nor position one to
  // impede their TOWER access) and G405 (never intentionally eject a SCORING ELEMENT from the FIELD).
  // Both are satisfied by construction here: targets are our own half or our own ALLIANCE ZONE, never
  // an opponent, and the landing is clamped inside the FIELD. A caller that aims too close to a HUB is
  // refused as well, so a pass can never become a disguised scoring shot.
  function releasePass(rb, tgt) {
    if (!tgt) return -1;
    const hub = GEO[rb.alliance].hub;
    if (Math.hypot(tgt.x - hub.x, tgt.y - hub.y) < PASS_HUB_CLEARANCE_IN) return -1;
    for (let i = 0; i < total; i++) {
      if (fstate[i] === 3 && fholder[i] === rb.idx) {
        fstate[i] = 4;
        fholder[i] = -1;
        fshooter[i] = rb.idx;
        fhub[i] = 3;
        fpx[i] = tgt.x;
        fpy[i] = tgt.y;
        ftimer[i] = PASS_FLIGHT_SEC;
        fvx[i] = (tgt.x - rb.x) / PASS_FLIGHT_SEC;
        fvy[i] = (tgt.y - rb.y) / PASS_FLIGHT_SEC;
        fox[i] = rb.x;
        foy[i] = rb.y;
        rb.carrying -= 1;
        flights.add(i);
        return i;
      }
    }
    return -1;
  }

  // ---- HUMAN PLAYER actions (§6.1, §5.9.2, G423, G425, G427) ----
  // The HP scores by throwing FUEL into its own HUB, which §6.1 states outright ("HUMAN PLAYERS can
  // deliver FUEL to ROBOTS or score them in their HUB"). The throw reuses the ROBOT flight path so the
  // HUB-active rule (Table 6-3), the 3 s assessment grace (§6.5) and the replay tracer are shared.
  // It is launched with fshooter = -1: no ROBOT statistic is touched, and because a lane blocker is
  // only sought for a shot that has a shooter, no ROBOT can block a throw that comes from off the
  // FIELD. That is the physical truth — the OUTPOST-to-HUB line is behind the ALLIANCE WALL.
  function throwFromHuman(hp) {
    const side = hp.side;
    const hub = GEO[side].hub;
    const start = GEO[side].human;
    for (let i = 0; i < total; i++) {
      if (fstate[i] !== HP_HAND) continue;
      fstate[i] = 4;
      fholder[i] = -1;
      fshooter[i] = -1;
      fhub[i] = side === 'red' ? 1 : 2;
      fscore[i] = rng() < sc.humanAccuracy[side] ? 1 : 0;
      ftimer[i] = HUMAN_FLIGHT_SEC;
      fx[i] = start.x;
      fy[i] = start.y;
      fvx[i] = (hub.x - start.x) / HUMAN_FLIGHT_SEC;
      fvy[i] = (hub.y - start.y) / HUMAN_FLIGHT_SEC;
      hp.hand -= 1;
      hp.stat.throws += 1;
      flights.add(i);
      return i;
    }
    return -1;
  }

  function updateHuman(hp, t) {
    const side = hp.side;
    const g = GEO[side];
    const pool = pools[side];
    let cmd = humanCmd[side] || 'HOLD';

    // G427: off-FIELD FUEL may only be stored in the CHUTE and the CORRAL, and once both are full the
    // excess must immediately be entered onto the FIELD. An HP that sits on a full store instead is at
    // a MINOR FOUL, and CONTINUOUS if it keeps it up. There is no way for an HP to hold the excess
    // itself beyond 2 FUEL, so "enter it" is the door.
    const storeFull = pool.chute >= FUEL.chuteCapacity && pool.corral >= FUEL.corralCapacity;
    if (storeFull) {
      const prev = hp.fullStoreSec;
      hp.fullStoreSec += tick;
      if (prev <= 3 && hp.fullStoreSec > 3) awardFoul(side, POINTS.foul.minor, 'G427 off-FIELD FUEL store overfilled', t, null);
      else if (hp.fullStoreSec > 3 && Math.floor((hp.fullStoreSec - 3) / 3) > Math.floor((prev - 3) / 3)) {
        awardFoul(side, POINTS.foul.major, 'G427 CONTINUOUS off-FIELD FUEL overfill', t, null);
      }
      cmd = 'DUMP';
    } else hp.fullStoreSec = 0;

    // The CHUTE DOOR swings ~90° on its pivot (§5.9.2). Anything the HP does with the CHUTE waits on
    // the door: a dump needs it open, a grab needs it shut (G423-A).
    const want = cmd === 'DUMP' ? 1 : 0;
    const swing = tick / DOOR_SWING_SEC;
    hp.door = want > hp.door ? Math.min(want, hp.door + swing) : Math.max(want, hp.door - swing);
    const open = hp.door > 0.5;

    // G425-A: with the door open the CHUTE drains itself down the 15° tunnel and out the upper
    // opening onto the FIELD, so opening the door IS the delivery.
    if (open && pool.chute > 0) {
      hp.dumpAcc += DUMP_PER_SEC * tick;
      while (hp.dumpAcc >= 1 && pool.chute > 0) {
        hp.dumpAcc -= 1;
        pool.chute -= 1;
        for (let i = 0; i < total; i++) {
          if (fstate[i] !== 1) continue;
          const land = placeLoose(i,
            g.dump.x + rng.range(-g.dump.w / 2, g.dump.w / 2),
            clamp(g.dump.y + rng.range(-g.dump.h / 2, g.dump.h / 2), 8, GEO.W - 8));
          fstate[i] = 0;
          fholder[i] = -1;
          fx[i] = land.x;
          fy[i] = land.y;
          hp.stat.dumped += 1;
          break;
        }
      }
    } else hp.dumpAcc = 0;

    // Throwing is rate-limited by the setup's throws/s, which is the only knob that makes an HP fast
    // or slow: the accuracy roll lives in throwFromHuman. An HP that cannot throw does not fill its
    // hand either, or the FUEL would sit in it for the rest of the MATCH.
    const rate = Math.max(0, sc.humanThrowPerSec[side]);

    // Feeding the hand: from the CHUTE while the door is shut, otherwise from the CORRAL (§5.9.2
    // sends the CHUTE to the upper opening and the CORRAL to the bottom one, and the HP can reach
    // both). A reach into the CHUTE past the tape line while the door is open is G423-A, so it is
    // simply refused here rather than foul-flagged: the HP can always wait for the door.
    if (cmd === 'SCORE' && rate > 0 && hp.hand < HP_HAND_CAP) {
      const source = pool.chute > 0 && !open ? 1 : pool.corral > 0 ? 2 : 0;
      if (source) {
        pool[source === 1 ? 'chute' : 'corral'] -= 1;
        for (let i = 0; i < total; i++) {
          if (fstate[i] !== source) continue;
          fstate[i] = HP_HAND;
          fholder[i] = -1;
          fx[i] = g.human.x + rng.range(-5, 5);
          fy[i] = g.human.y + rng.range(-5, 5);
          hp.hand += 1;
          break;
        }
      }
    }

    if (cmd === 'SCORE' && hp.hand > 0 && rate > 0) {
      hp.throwClock += tick;
      const interval = 1 / rate;
      while (hp.throwClock >= interval && hp.hand > 0) {
        hp.throwClock -= interval;
        if (throwFromHuman(hp) < 0) break;
      }
    } else hp.throwClock = 0;

    hp.action = cmd;
  }

  // The nearest opponent whose BUMPERS straddle the launch lane. Called once per flight per tick with
  // the segment the FUEL just travelled, so a ROBOT is only credited with a block it was actually
  // standing in front of.
  function laneBlocker(shooterAlliance, x0, y0, x1, y1) {
    let hit = null;
    let best = Infinity;
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    // The lane's normal: a square blocker covers the lane by however much of itself projects onto it,
    // which is its own side when it is square to the shot and sqrt(2) times that when it is corner-on.
    const nx = -(y1 - y0) / len;
    const ny = (x1 - x0) / len;
    for (const o of robots) {
      if (o.alliance === shooterAlliance || o.disabled) continue;
      // A ROBOT hanging on the TOWER is above the lane, not in it.
      if (o.climb.attaching || o.climb.progress > 0 || o.climb.done) continue;
      const d = segmentPointDistance(x0, y0, x1, y1, o.x, o.y);
      const r = shotBlockRadius(o, nx, ny);
      if (d > r || d / r >= best) continue;
      best = d / r;
      hit = o;
    }
    return hit;
  }

  // A blocked launch is not a scoring attempt that missed: the FUEL is still on the FIELD, so it
  // becomes loose where it hit and can be swept up again. Nothing scores, and the shot is charged to
  // the shooter as a blocked attempt (never a foul — G404 penalises *deliberately* launching at an
  // opponent, and a defender that drives into the lane is the one choosing the contact).
  function blockedFlight(i, shooter, blocker) {
    flights.delete(i);
    const land = placeLoose(i, fx[i], fy[i]);
    fstate[i] = 0;
    fx[i] = land.x;
    fy[i] = land.y;
    fhub[i] = 0;
    fscore[i] = 0;
    flegal[i] = 0;
    fholder[i] = -1;
    fshooter[i] = -1;
    fnointake[i] = 0.6;
    nointakeActive += 1;
    if (shooter) shooter.stat.shotsBlocked += 1;
    if (blocker) blocker.stat.blocks += 1;
    rebuildHint();
  }

  function resolveFlight(i, t) {
    flights.delete(i);
    if (fhub[i] === 3) {
      // A PASS is a launch that is not aimed at a HUB, so it scores nothing: the FUEL simply comes
      // down near the aim point as loose FUEL for a partner. The landing spreads with the length of
      // the pass, because nobody throws a ball 400 in onto a plate.
      const spread = 0.12 * Math.hypot(fpx[i] - fx[i], fpy[i] - fy[i]);
      const land = placeLoose(i, fpx[i] + rng.range(-spread, spread), fpy[i] + rng.range(-spread, spread));
      fstate[i] = 0;
      fx[i] = land.x;
      fy[i] = land.y;
      fholder[i] = -1;
      fshooter[i] = -1;
      rebuildHint();
      return;
    }
    const target = fhub[i] === 1 ? 'red' : 'blue';
    const hub = GEO[target].hub;
    const dir = target === 'red' ? 1 : -1;
    const rb = fshooter[i] >= 0 ? robots[fshooter[i]] : null;
    // §5.4: the net at the back of the HUB stops a shot launched from outside the shooter's ALLIANCE
    // ZONE. The HUB sits on the ALLIANCE ZONE line, so that is a ROBOT firing at its own HUB from
    // behind it: the ball strikes the net above the back face and falls at its base on the NEUTRAL
    // ZONE side, scoring nothing. A HUMAN PLAYER's throw is exempt — it leaves from the OUTPOST and
    // enters the opening from the front (§6.1), and it has no shooter ROBOT (fshooter === -1), so
    // `rb` is null here.
    if (rb && flegal[i] === 0) {
      const land = placeLoose(i,
        hub.x + dir * (FIELD.hub.sizeIn / 2 + rng.range(NET_DROP_NEAR_IN, NET_DROP_FAR_IN)),
        clamp(hub.y + rng.range(-50, 50), 8, GEO.W - 8));
      fstate[i] = 0;
      fx[i] = land.x;
      fy[i] = land.y;
      fholder[i] = -1;
      fshooter[i] = -1;
      rebuildHint();
      return;
    }
    if (!fscore[i]) {
      // A shot that misses the opening cannot pass through the HUB and reappear on the far side: the
      // opening sits on top of a solid prism with a net at its back, so the ball strikes the structure
      // and comes down at its base, on the side it came from — the face the shooter was aiming at. A
      // ROBOT shooting from its ALLIANCE ZONE is in front of that face, so the FUEL lands in its own
      // zone, reachable. The old branch dropped it 20-95 in past the HUB centre instead, which is up
      // to 71.5 in past the back face, and a replay drew those balls sailing across the HUB's midfield
      // edge untouched. `sc.netMiss = false` restores that drop, as the verifier's control.
      //
      // Where a stopped shot comes down is not cosmetic: measured on two greedy mirrors, landing at
      // the back face instead (the first cut at this) took the mirror from 613 to 575, because FUEL
      // pressed against the HUB's back is hard for a ROBOT to reach. Landing in front instead puts the
      // mirror at 635 against the real Einstein average of 627.
      const land =
        sc.netMiss === false
          ? placeLoose(i, hub.x + dir * rng.range(20, 95), hub.y + rng.range(-95, 95))
          : placeLoose(i, hub.x - dir * (FIELD.hub.sizeIn / 2 + rng.range(NET_DROP_NEAR_IN, MISS_DROP_FAR_IN)), clamp(hub.y + rng.range(-60, 60), 8, GEO.W - 8));
      fstate[i] = 0;
      fx[i] = land.x;
      fy[i] = land.y;
      fholder[i] = -1;
      fshooter[i] = -1;
      rebuildHint();
      return;
    }
    // Everything below went in.
    {
      // A launch with no shooter ROBOT is a HUMAN PLAYER's (§6.1), and the HUB it is aimed at is
      // always its own ALLIANCE's, so the throw belongs to that side's HP. The hit is counted here,
      // outside the active branch: whether an accurate throw was worth a point depends on the HUB
      // window, but whether it went in is the accuracy roll, and the two are separate facts.
      if (!rb) hps[target].stat.hits += 1;
      if (hubActive(target, t)) {
        score[target].fuel += POINTS.fuelActiveHub;
        if (t < TIME.autoSec + TIME.autoScoreGraceSec) autoFuel[target] += 1;
        if (rb) rb.stat.fuelScored += 1;
      } else {
        score[target].fuelInactive += 1;
        if (rb) rb.stat.fuelWasted += 1;
      }
      // A HUB processes FUEL and redistributes it into the NEUTRAL ZONE via its exits (§5.4),
      // which is why 504 FUEL circulate all MATCH instead of running out. Processing costs time
      // (§6.5 allows for FUEL processing time) and the FUEL is spread across the NEUTRAL ZONE, so
      // camping the exits is neither free nor fast.
      fstate[i] = 6;
      ftimer[i] = FIELD.hub.processingSec;
      fhub[i] = target === 'red' ? 1 : 2;
      processing.add(i);
    }
  }

  function completeClimb(rb, t) {
    // The ROBOT is ON the rung, not wherever it happened to be when the progress counter filled: it
    // drives up to the TOWER face and settles into its lane. Snapping matters because a ROBOT that
    // climbs during TELEOP is frozen there for the rest of the MATCH, and one that climbed in AUTO
    // starts its dismount from the same place.
    const spot = climbSpotFor(rb);
    rb.x = spot.x;
    rb.y = spot.y;
    rb.vx = 0;
    rb.vy = 0;
    const want = Math.min(rb.intent.level || 1, rb.derived.maxClimbLevel);
    const p = periodAt(t);
    if (p === 'AUTO') {
      const l1 = robots.filter((r) => r.alliance === rb.alliance && r.climb.autoLevel >= 1).length;
      if (want >= 1 && l1 < 2) {
        rb.climb.autoLevel = 1;
        score[rb.alliance].towerAuto += POINTS.tower.l1Auto;
        rb.stat.climbLevel = 1;
        rb.stat.climbPoints += POINTS.tower.l1Auto;
        log(t, 'climb', { robot: rb.idx, level: 1, period: 'AUTO' });
      }
    } else {
      const level = Math.max(1, want);
      rb.climb.level = level;
      const pts =
        level === 1
          ? sc.towerL1TeleopAllowed
            ? POINTS.tower.l1Teleop
            : 0
          : level === 2
            ? POINTS.tower.l2Teleop
            : POINTS.tower.l3Teleop;
      score[rb.alliance].towerTeleop += pts;
      rb.stat.climbLevel = level;
      rb.stat.climbPoints += pts;
      log(t, 'climb', { robot: rb.idx, level, period: p });
    }
  }

  const makeObs = (t) => ({
    t,
    period,
    hub: { red: hubActive('red', t), blue: hubActive('blue', t) },
    // After AUTO the FMS relays the ALLIANCE-SHIFT HUB order to every OPERATOR CONSOLE (§6.4.1),
    // so a policy may legitimately plan against the remaining schedule.
    schedule: hubSchedule,
    autoFuel: { ...autoFuel },
    score,
    pools,
    robots,
    // The HP's own state, so a policy can decide between scoring, dumping the CHUTE and doing
    // nothing. `x`/`s` are the throw and score counters the replay reports.
    human: { red: hpSnap(hps.red, 'red'), blue: hpSnap(hps.blue, 'blue') },
    geo: GEO,
    fuel: { x: fx, y: fy, state: fstate, total },
    scenario: sc,
  });

  for (const side of ['red', 'blue']) {
    const pol = policies[side];
    if (pol.reset) pol.reset({ scenario: sc, alliance: alliances[side], geo: GEO, side });
    if (pol.onPeriodStart) pol.onPeriodStart('AUTO', makeObs(0));
  }

  for (let step = 0; step < steps; step++) {
    const t = step * tick;
    const order = serveOrder[step % 2];
    const p = periodAt(t);
    if (p !== period) {
      period = p;
      if (p === 'TRANSITION') {
        // An AUTO climb is the one climb a ROBOT walks away from: §6.5.2 anticipates it ("an AUTO
        // climb does not block a TELEOP climb"), which only means anything if the ROBOT gets back
        // onto the carpet. So it comes down from the rung it actually holds — NOT a teleport into
        // the middle of the ALLIANCE ZONE — and pays for the drop in TRANSITION SHIFT time, which is
        // 10 s with both HUBs active. A TELEOP climb is the opposite: that ROBOT is on the TOWER
        // when the MATCH is assessed and never comes down (see the freeze in the play loop).
        for (const rb of robots) {
          if (rb.climb.autoLevel >= 1) {
            const spot = climbSpotFor(rb);
            rb.x = spot.x;
            rb.y = spot.y;
            rb.vx = 0;
            rb.vy = 0;
            rb.climb.progress = 0;
            rb.climb.attaching = true; // still on the TOWER until the dismount finishes
            rb.climb.attachClock = 0;
            rb.climb.dismountLeft = Math.max(0.8, rb.climb.timeSec * 0.5);
            rb.climb.done = false;
            rb.climb.level = 0;
          }
        }
        // AUTO result sets the HUB order for the ALLIANCE SHIFTS (§6.4.1 / Table 6-3).
        autoWinner =
          sc.autoWinner === 'red' || sc.autoWinner === 'blue'
            ? sc.autoWinner
            : autoFuel.red === autoFuel.blue
              ? rng.chance(0.5)
                ? 'red'
                : 'blue'
              : autoFuel.red > autoFuel.blue
                ? 'red'
                : 'blue';
        hubSchedule = hubActiveTable(autoWinner);
        log(t, 'hubSchedule', { autoWinner, autoFuel: { ...autoFuel } });
      }
      for (const side of ['red', 'blue']) {
        if (policies[side].onPeriodStart) policies[side].onPeriodStart(p, makeObs(t));
      }
      log(t, 'period', { period: p });
    }

    if (step % 5 === 0 || gridDirty > 60) {
      rebuildGrid();
      gridDirty = 0;
    }

    for (const rb of robots) {
      if (rb.fault && !rb.fault.done && t >= rb.fault.at) {
        rb.fault.done = true;
        rb.health = rb.fault.hard ? 0 : 0.55;
        if (rb.fault.hard) rb.disabled = true;
        log(t, 'fault', { robot: rb.idx, hard: rb.fault.hard });
      }
      // A damaging contact's impairment is timed: the ROBOT comes back, which is the manual's own
      // "~20+ seconds" for being unable to drive and a shorter window for the milder impairment.
      if (rb.impairLeft > 0) {
        rb.impairLeft = Math.max(0, rb.impairLeft - tick);
        rb.stat.impairedSec += tick;
        if (rb.impairLeft === 0) rb.impairFactor = 1;
      }
      if (rb.contactCooldown > 0) rb.contactCooldown = Math.max(0, rb.contactCooldown - tick);
    }

    if (step % decideEvery === 0) {
      // The side that decides first keeps the pile it names, so the decision pass needs an order that
      // actually turns over: decisions run every `decideEvery` ticks, and alternating on `step % 2` here
      // would land on the same parity every time and never swap.
      for (const side of Math.floor(step / decideEvery) % 2 === 0 ? ['red', 'blue'] : ['blue', 'red']) {
        const obs = makeObs(t);
        // The HP is a decision-maker of its own: a policy that does not implement `human` leaves it
        // parked at the CHUTE, which is a legal (if wasteful) way to run a MATCH.
        if (policies[side].human) {
          const c = policies[side].human(obs, side);
          const a = typeof c === 'string' ? c : c && c.action;
          humanCmd[side] = a === 'SCORE' || a === 'DUMP' ? a : 'HOLD';
        } else humanCmd[side] = 'HOLD';
        for (const rb of robots) {
          if (rb.alliance !== side || rb.disabled) continue;
          rb.intent = policies[side].decide(rb, obs) || { mode: INTENT.IDLE };
        }
      }
    }

    for (const rb of robots) rb.defensePressure = 0;

    // ---- DEFEND: denial pressure and PIN adjudication (G418) ----
    for (const rb of order) {
      if (rb.disabled) continue;
      if (rb.g420Cooldown > 0) rb.g420Cooldown -= tick;
      if (rb.intent.mode !== INTENT.DEFEND) {
        rb.pinTimer = Math.max(0, rb.pinTimer - tick * 3);
        continue;
      }
      const tgt = robots[rb.intent.targetRobot];
      if (!tgt || tgt.alliance === rb.alliance || tgt.disabled) continue;
      const d = Math.hypot(rb.x - tgt.x, rb.y - tgt.y);
      if (d >= 34) {
        rb.pinTimer = Math.max(0, rb.pinTimer - tick * 3);
        continue;
      }
      const pressure = clamp(rb.defenseSkill * 0.55 + rb.defensePower * 0.55, 0, 1);
      tgt.defensePressure = Math.max(tgt.defensePressure, pressure);
      tgt.stat.blockedByOpponentSec += tick;
      const zone = GEO[tgt.alliance].allianceZone;
      const insideOwnZone = tgt.x >= zone[0] && tgt.x <= zone[1];
      const speed = Math.hypot(tgt.vx, tgt.vy);
      if (speed < 12 && !insideOwnZone) {
        const prev = rb.pinTimer;
        rb.pinTimer += tick;
        if (prev <= 3 && rb.pinTimer > 3) {
          awardFoul(rb.alliance, POINTS.foul.minor, 'G418 PIN over 3 s', t, rb);
          rb.stat.pins += 1;
        } else if (rb.pinTimer > 3 && Math.floor((rb.pinTimer - 3) / 3) > Math.floor((prev - 3) / 3)) {
          awardFoul(rb.alliance, POINTS.foul.major, 'G418 PIN not corrected', t, rb);
          rb.stat.pins += 1;
        }
      } else {
        rb.pinTimer = Math.max(0, rb.pinTimer - tick * 2);
      }
    }

    // ---- G419: two or more ROBOTS isolating traversal (blocking both BUMPS and both TRENCHES)
    for (const side of ['red', 'blue']) {
      const g = GEO[side];
      const opp = other(side);
      const bumpY = new Set();
      const trenchY = new Set();
      let inBandCount = 0;
      let oppFree = 0;
      for (const r of robots) {
        if (r.disabled) continue;
        if (r.alliance === opp) {
          if (r.x < g.band[0] || r.x > g.band[1]) oppFree += 1;
          continue;
        }
        if (r.x < g.band[0] || r.x > g.band[1]) continue;
        inBandCount += 1;
        for (const c of g.corridors) {
          if (Math.abs(r.y - c.y) < c.half + 8) (c.kind === 'bump' ? bumpY : trenchY).add(c.y);
        }
      }
      const isolates = bumpY.size + trenchY.size >= 4 && oppFree === 0 && inBandCount >= 2;
      if (isolates) {
        const prev = blockState[side];
        blockState[side] += tick;
        if (prev <= 3 && blockState[side] > 3) awardFoul(side, POINTS.foul.major, 'G419 isolating traversal routes', t, null);
        else if (blockState[side] > 3 && Math.floor((blockState[side] - 3) / 3) > Math.floor((prev - 3) / 3)) {
          awardFoul(side, POINTS.foul.major, 'G419 continued isolation', t, null);
        }
      } else blockState[side] = Math.max(0, blockState[side] - tick * 2);
    }

    const towerProtected = t > TIME.matchSec - TIME.endgameSec;

    for (const rb of order) {
      if (rb.disabled) continue;
      // A ROBOT on the TOWER plays no further part in the MATCH. TELEOP TOWER points are assessed
      // when the MATCH ends (§6.5.2), so a ROBOT that has climbed during TELEOP is up there for
      // good: without this freeze it kept the TOWER points it had already banked AND drove off to
      // score FUEL for the rest of END GAME, a double dip no real ROBOT can make. The AUTO climb is
      // released separately at TRANSITION, where the ROBOT drops back onto the carpet.
      if (rb.climb.done) {
        rb.vx = 0;
        rb.vy = 0;
        rb.turnVel = 0;
        // Report what it is actually doing: the policy keeps asking for SCORE/COLLECT because it has
        // no way to know the MATCH is over for this ROBOT, and a replay that shows it "scoring" while
        // it sits on a rung reads like a bug.
        rb.intent = { mode: INTENT.CLIMB, level: rb.climb.level };
        rb.stat.activeSec += tick;
        continue;
      }
      if (rb.climb.dismountLeft > 0) {
        rb.climb.dismountLeft = Math.max(0, rb.climb.dismountLeft - tick);
        rb.vx = 0;
        rb.vy = 0;
        rb.turnVel = 0;
        rb.intent = { mode: INTENT.CLIMB, level: 1 };
        if (rb.climb.dismountLeft === 0) rb.climb.attaching = false;
        rb.stat.activeSec += tick;
        continue;
      }
      const intent = rb.intent;
      const g = GEO[rb.alliance];

      let tx = rb.x;
      let ty = rb.y;
      switch (intent.mode) {
        case INTENT.COLLECT:
        case INTENT.STOCKPILE:
          if (intent.target) {
            tx = intent.target.x;
            ty = intent.target.y;
          }
          break;
        case INTENT.SCORE:
          // A turret may nominate its own firing point inside the ALLIANCE ZONE; a full-width
          // shooter is driven to its own DRIVER STATION's lane at the HUB face, because that is the
          // only place it can shoot from and a shared lane would have it fighting its partners.
          tx = intent.target ? intent.target.x : g.shootStations[rb.slot].x;
          ty = intent.target ? intent.target.y : g.shootStations[rb.slot].y;
          break;
        case INTENT.PASS:
          // A pass is thrown from where the ROBOT already is — that is the whole point of keeping the
          // collector on the far side instead of driving it home — so it holds position.
          tx = rb.x;
          ty = rb.y;
          break;
        case INTENT.DEFEND: {
          const tgt = robots[intent.targetRobot];
          if (tgt) {
            tx = tgt.x + tgt.vx * 0.45;
            ty = tgt.y + tgt.vy * 0.45;
          }
          break;
        }
        case INTENT.CLIMB: {
          tx = climbSpotFor(rb).x;
          ty = climbSpotFor(rb).y;
          break;
        }
        case INTENT.FEED: {
          const m = corralMouth(rb.alliance);
          tx = m.x;
          ty = m.y;
          break;
        }
        case INTENT.PUSH: {
          // To shove FUEL toward our own half the ROBOT has to come at the pile from the FAR side:
          // driving into a ball from the home side is what sends it the wrong way. So a pusher that is
          // not yet past its target first takes a staging point beyond and beside the pile — the
          // lateral offset keeps the approach clear of the 22 in push radius — and only then lines up
          // through it. The target is a FUEL position; the policy re-picks as the pile moves.
          const tgt = intent.target;
          if (tgt) {
            const away = rb.alliance === 'red' ? 1 : -1; // unit direction away from our own goal line
            const beyond = (rb.x - tgt.x) * away > 25;
            if (beyond) {
              tx = tgt.x;
              ty = tgt.y;
            } else {
              tx = tgt.x + away * 45;
              ty = tgt.y + (rb.y > tgt.y ? 75 : -75);
            }
          }
          break;
        }
        default:
          if (intent.target) {
            tx = intent.target.x;
            ty = intent.target.y;
          }
      }

      const wp = navTarget(rb, tx, ty);
      const dx = wp.x - rb.x;
      const dy = wp.y - rb.y;
      const dist = Math.hypot(dx, dy) || 1;
      let maxSpeed = rb.driveSpeedIps * capability(rb) * (1 - 0.7 * rb.defensePressure);
      if (intent.mode === INTENT.CLIMB && dist < 30) maxSpeed *= 0.45;
      if (!rb.canTrench && Math.abs(rb.x - g.band[0]) < FIELD.bump.depthIn + 10) maxSpeed *= 0.72;
      // Closed-loop position control: ROBOTS decelerate into a waypoint instead of overshooting it
      // at full speed, otherwise they oscillate around their goal and never settle.
      const desired = Math.min(maxSpeed, dist * 4.5);

      // ---- heading, turned first because a chassis that cannot strafe gets its velocity FROM it ----
      // What this ROBOT wants to face. An explicit aim point wins; failing that, a ROBOT under SCORE
      // turns its shooting face onto the HUB. That is resolved here in the engine rather than left to
      // the policy because a Dumper's shooter is bolted to one face of a square, so the rule has to
      // bind on every policy that plays - the hand-written baselines included - and not only on one
      // that remembers to ask for it. Otherwise the heading is the direction of travel, which is where
      // a front-mounted intake points, and a ROBOT that has arrived keeps the heading it arrived with.
      const arrived = dist <= 8;
      const aimDeg = intent.face
        ? bearingDeg(intent.face.x - rb.x, intent.face.y - rb.y)
        : intent.mode === INTENT.SCORE
          ? bearingDeg(g.hub.x - rb.x, g.hub.y - rb.y)
          : null;
      const travelDeg = arrived ? null : bearingDeg(dx, dy);
      const canStrafe = rb.chassisLateral > 0;
      // A drivetrain with no sideways motion reverses rather than spending a second and a half turning
      // around, and its heading then points away from where it is actually going.
      const reversing =
        !canStrafe && travelDeg !== null && Math.abs(angleDeltaDeg(travelDeg, rb.heading / DEG)) > 90;
      // Which end of the car leads the trip. A ROBOT sweeps a pile with its intake mouth, so when the
      // mouth is not on the front it turns that face toward where it is going and trails the rest of the
      // car behind it — a rear intake backs into the pile at the chassis's reverse fraction of top speed,
      // and a side intake has to strafe. A tank drive has no strafe, so a tank with a side intake keeps
      // driving nose-first and only swallows what the side brushes past; that is the honest cost of the
      // combination, not a fallback. COLLECT is the only mode this applies to: STOCKPILE is a positioning
      // move, and a ROBOT hurrying home before its HUB opens should not have to reverse the whole way.
      // PUSH is left out because a pusher wants a BUMPER on the pile, never the mouth, and FEED because
      // its destination is a wall opening it has to park beside, not a pile to swallow — leading with a
      // rear mouth there backs the car into the OUTPOST and loses the CORRAL mouth.
      const intakeLead =
        intent.mode === INTENT.COLLECT &&
        rb.intakeOffsetDeg !== 0 &&
        !(Math.abs(rb.intakeOffsetDeg) === 90 && !canStrafe)
          ? rb.intakeOffsetDeg
          : 0;
      const headTarget = reversing
        ? travelDeg + 180
        : aimDeg !== null
          ? aimDeg
          : travelDeg !== null
            ? travelDeg - intakeLead
            : null;
      if (headTarget !== null) {
        const speedFrac = Math.min(1, Math.hypot(rb.vx, rb.vy) / Math.max(40, rb.driveSpeedIps));
        // Turning at speed costs traction and the chassis says how much: a swerve's four modules steer
        // on their own and barely notice, a tank drive has to scrub both sides and loses nearly half.
        const turnRate =
          (rb.turnRateDegPerSec || 360) * capability(rb) * (1 - (1 - rb.chassisTurnAtSpeed) * speedFrac);
        const delta = angleDeltaDeg(headTarget, rb.heading / DEG);
        // sc.turnRampOff = true restores the old single-tick snap, so the ramp can be measured against a
        // control rather than asserted.
        if (sc.turnRampOff) {
          rb.heading += clamp(delta, -turnRate * tick, turnRate * tick) * DEG;
          rb.turnVel = 0;
        } else {
          // The peak rate above is a ceiling, not a step. `brake` is the spin rate that can still be
          // brought to zero inside the angle that is left, which is what stops the ramp from ringing past
          // its target and hunting; `ramp` is how much the spin rate may change in one tick.
          const accel = rb.turnAccelDegPerSec2 || turnRate / 0.3;
          const brake = Math.sqrt(2 * accel * Math.abs(delta));
          const cmd = clamp(delta, -Math.min(turnRate, brake) * tick, Math.min(turnRate, brake) * tick) / tick;
          const ramp = accel * tick;
          rb.turnVel += clamp(cmd - rb.turnVel, -ramp, ramp);
          rb.heading += rb.turnVel * tick * DEG;
        }
        if (rb.heading > Math.PI) rb.heading -= 2 * Math.PI;
        else if (rb.heading <= -Math.PI) rb.heading += 2 * Math.PI;
      } else if (rb.turnVel !== 0 && !sc.turnRampOff) {
        // No heading to hold: the spin still has to be bled off instead of vanishing.
        const ramp = (rb.turnAccelDegPerSec2 || 1200) * tick;
        rb.turnVel -= clamp(rb.turnVel, -ramp, ramp);
      }
      const cosH = Math.cos(rb.heading);
      const sinH = Math.sin(rb.heading);
      rb.hx = cosH;
      rb.hy = sinH;
      if (rb.intakeOffsetDeg) {
        const aim = rb.heading + rb.intakeOffsetDeg * DEG;
        rb.ix = Math.cos(aim);
        rb.iy = Math.sin(aim);
      } else {
        rb.ix = cosH;
        rb.iy = sinH;
      }

      // ---- velocity, through the chassis. The wanted velocity is split into the heading frame and what
      // the drivetrain can do with the two halves IS the difference between them: a swerve takes both at
      // full value and goes anywhere, a tank drive throws the sideways half away and only travels along
      // its heading, a mecanum keeps the sideways half at a discount because its rollers slip.
      const udx = dx / dist;
      const udy = dy / dist;
      let fwd = (udx * cosH + udy * sinH) * desired;
      let lat = (udx * -sinH + udy * cosH) * desired * rb.chassisLateral;
      if (fwd < 0) fwd *= rb.chassisReverse;
      const maxDelta = rb.accelIps2 * tick;
      rb.vx += clamp(fwd * cosH - lat * sinH - rb.vx, -maxDelta, maxDelta);
      rb.vy += clamp(fwd * sinH + lat * cosH - rb.vy, -maxDelta, maxDelta);
      const px = rb.x;
      const py = rb.y;
      rb.x += rb.vx * tick;
      rb.y += rb.vy * tick;
      rb.distance += Math.hypot(rb.x - px, rb.y - py);
      obstacleResolve(rb);
      bulldoze(rb);

      for (const o of robots) {
        if (o === rb || o.disabled) continue;
        const d = Math.hypot(o.x - rb.x, o.y - rb.y);
        // Broad phase on the circumscribed circles; squareContact does the real test.
        if (d >= (footprintHalf(rb) + footprintHalf(o)) * 1.4143) continue;
        // A ROBOT anchored to the TOWER is not shoved around, and ALLIANCE partners may not
        // support each other to climb (G414).
        const anchored = (r) => r.climb.attaching || r.climb.progress > 0 || r.climb.done;
        if (anchored(rb) || anchored(o)) continue;
        // Two partners staging on the same TOWER are climbing different LEVELS of one 3-D structure,
        // so in this top-down view they overlap instead of shoving each other off the base. Without
        // this, a three-ROBOT climb degenerates into a shoving match at the TOWER.
        const onTower = (r) =>
          r.intent.mode === INTENT.CLIMB &&
          Math.hypot(r.x - GEO[r.alliance].tower.x, r.y - GEO[r.alliance].tower.y) < 46;
        if (rb.alliance === o.alliance && onTower(rb) && onTower(o)) continue;
        const hit = squareContact(o, rb);
        if (!hit) continue;
        // `ux, uy` points from `o` to `rb` along the shallowest separating axis, so the rate the gap
        // closes at is (v_o - v_r) . u. Read it BEFORE the response below changes either velocity: it is
        // both the impulse the bumpers absorb and the impact speed the contact rules are judged on.
        const closeRb = hit.ux * (o.vx - rb.vx) + hit.uy * (o.vy - rb.vy);
        const ux = hit.ux;
        const uy = hit.uy;
        const w = rb.weightLb / (rb.weightLb + o.weightLb);
        // Each ROBOT takes its INVERSE-mass share of the separation: the heavier one moves less. The
        // other way round has a 134 lb ROBOT being launched by a 124 lb one, which is why the mass
        // difference has to appear here rather than only in the foul severity below.
        const pen = hit.pen * 0.55;
        rb.x += ux * pen * (1 - w);
        rb.y += uy * pen * (1 - w);
        o.x -= ux * pen * w;
        o.y -= uy * pen * w;
        // Bumper contact exchanges momentum along the normal. Without this two ROBOTs that meet head-on
        // keep driving into each other for a second and a half while the position correction crawls
        // them apart, which reads as passing through one another; taking the closing velocity off in
        // one tick makes them meet, stop and slide around, and it is what lets a heavier ROBOT hold a
        // corridor. The split conserves momentum exactly (m_r * dv_r + m_o * dv_o = 0).
        //
        // sc.contactRestitution is the bumper's coefficient of restitution: 0 is perfectly inelastic
        // (they meet and stop), and -1 removes the impulse altogether and leaves only the positional
        // correction above, which is the control the verifier and the A/B measure this against. FRC
        // BUMPERS are foam over plywood, so the shipped value is low: they absorb most of a hit.
        const rest = sc.contactRestitution ?? CONTACT_RESTITUTION;
        if (rest > -1 && closeRb > 0) {
          const j = closeRb * (1 + rest);
          rb.vx += ux * j * (1 - w);
          rb.vy += uy * j * (1 - w);
          o.vx -= ux * j * w;
          o.vy -= uy * j * w;
        }

        // ---- G415 / G416 / G417: opponent interaction (one adjudication per collision) ----
        // Judged on the tick the BUMPERS first overlap, where the closing rate is still the impact
        // speed. `ux, uy` points from `o` to `rb`, so the rate the gap closes at is (v_o - v_r) . u and
        // whoever is closing harder initiated it - the manual's own test, "moving towards the opponent
        // ROBOT" with "reasonable possibility to have avoided the contact". Each pair is looked at once
        // (rb.idx < o.idx) and the three rules are mutually exclusive (§7.4.4): at most one is assessed.
        if (o.alliance !== rb.alliance && rb.idx < o.idx && sc.contactFouls) {
          const rammer = closeRb >= 0 ? rb : o;
          const victim = rammer === rb ? o : rb;
          const severity = Math.abs(closeRb) * (rammer.weightLb / victim.weightLb);
          const floor = sc.contactHitSeverity ?? CONTACT_HIT_SEVERITY;
          if (severity >= floor && rammer.contactCooldown <= 0 && !victim.disabled && !rammer.disabled) {
            rammer.contactCooldown = 3;
            // A rammer that was pressuring THIS opponent is the "intentionally and/or recklessly" case
            // (G416); only that can tip somebody, because "tipping as an unintended consequence of
            // normal ROBOT to ROBOT interaction ... is not a violation" (G417). A ROBOT that had left
            // its ALLIANCE ZONE answers for damage it causes without intent (G415), and contact inside
            // its own half that is neither deliberate nor a tip is legal - G415 example B assigns "no
            // violation" to exactly that hit - so nothing is assessed and no damage roll is spent.
            const deliberate = rammer.intent.mode === INTENT.DEFEND && rammer.intent.targetRobot === victim.idx;
            const tipped = deliberate && severity >= (sc.contactTipSeverity ?? CONTACT_TIP_SEVERITY);
            const zone = GEO[rammer.alliance].allianceZone;
            const outside = rammer.alliance === 'red'
              ? rammer.x - footprintHalf(rammer) > zone[1]
              : rammer.x + footprintHalf(rammer) < zone[0];
            const code = tipped ? 'G417' : deliberate ? 'G416' : outside ? 'G415' : null;
            // "no damage seen so no violation is assigned" (G415 example A): a deliberate tip is the
            // violation itself, anything else needs the roll to say something actually broke.
            const p = sc.contactImpairP ?? Math.min(CONTACT_MAX_IMPAIR_P, (severity - floor) / CONTACT_IMPAIR_RAMP);
            if (code && (tipped || rng() < p)) {
              // A RED CARD is the escalated version of the same call, and the three rules reach it
              // differently: G415 and G416 escalate only when the opponent "is unable to drive", while
              // G417 also escalates when the contact is CONTINUOUS, which is modelled as the same
              // ROBOT doing it again in the MATCH. Otherwise the ROBOT is impaired, not out: it is
              // back to full capability after 20 s.
              const unable =
                severity >= CONTACT_UNABLE_SEVERITY || (code === 'G417' && rammer.contactFouls > 0);
              victim.impairLeft = unable ? CONTACT_IMPAIR_SEC : CONTACT_IMPAIR_MINOR_SEC;
              victim.impairFactor = unable ? 0 : CONTACT_IMPAIR_FACTOR;
              const card = unable ? 'RED' : 'YELLOW';
              rammer.contactFouls += 1;
              awardFoul(rammer.alliance, POINTS.foul.major, `${code} ${CONTACT_FOUL_TEXT[code]} (MAJOR FOUL + ${card} CARD)`, t, rammer);
              log(t, 'contact', { rammer: rammer.idx, victim: victim.idx, at: Math.round(rammer.x), severity: Math.round(severity), code, card });
            }
          }
        }
      }

      // ---- G420 TOWER protection (last 30 s of the MATCH) ----
      if (towerProtected && rb.g420Cooldown <= 0) {
        for (const o of robots) {
          if (o.alliance === rb.alliance || o.disabled) continue;
          const og = GEO[o.alliance];
          if (Math.hypot(o.x - og.tower.x, o.y - og.tower.y) < 42 && Math.hypot(o.x - rb.x, o.y - rb.y) < 30) {
            awardFoul(rb.alliance, POINTS.foul.major, 'G420 TOWER protection contact', t, rb);
            rb.g420Cooldown = 6;
            if (o.climb.level < 3) {
              score[o.alliance].towerTeleop += POINTS.tower.l3Teleop;
              o.climb.level = 3;
              log(t, 'towerAwarded', { robot: o.idx, reason: 'G420' });
            }
            break;
          }
        }
      }

      // ---- actions ----
      switch (intent.mode) {
        case INTENT.COLLECT:
        case INTENT.STOCKPILE: {
          // A turret's shooter slews independently of the drivetrain, so it does not have to be under
          // SCORE to shoot: inside its own ALLIANCE ZONE (G407) and inside the range where the shot is
          // still worth taking, it keeps the rollers running and fires at the same time. This is what
          // "fires on the move" actually buys, and it is the gap a full-width Dumper cannot close
          // because it has to park and square its one shooting face up to the goal first.
          turretOpportunityFire(rb, g, t);
          sweep(rb, t);
          break;
        }
        case INTENT.SCORE: {
          fireAtHub(rb, g);
          // Swept AFTER the shot so a FUEL cannot be ingested and launched inside the same tick.
          sweep(rb, t);
          break;
        }
        case INTENT.PASS: {
          const tgt = intent.target;
          if (tgt && rb.carrying > 0) {
            rb.passClock += tick;
            const interval = 1 / Math.max(0.4, rb.shootRate * capability(rb) * (1 - 0.5 * rb.defensePressure));
            while (rb.passClock >= interval && rb.carrying > 0) {
              rb.passClock -= interval;
              if (releasePass(rb, tgt) < 0) break;
            }
          } else rb.passClock = 0;
          // A PASS throws from where the ROBOT already stands, so the rollers have no reason to stop.
          sweep(rb, t);
          break;
        }
        case INTENT.PUSH:
          // Deliberately no intake, and this is the one action where that matters: a pusher that also
          // swallowed every ball it drove over would not be pushing FUEL anywhere. The whole play is
          // to move loose FUEL with the BUMPER and leave it on the FIELD for a partner (or for the
          // next own-half cycle), so the rollers stay off here.
          break;
        case INTENT.FEED: {
          const m = corralMouth(rb.alliance);
          const inside = Math.hypot(rb.x - m.x, rb.y - m.y) < 30;
          if (inside && rb.carrying > 0) {
            rb.depositClock += tick;
            const interval = 1 / Math.max(0.4, rb.intakeRate * 0.7);
            while (rb.depositClock >= interval && rb.carrying > 0) {
              rb.depositClock -= interval;
              // A full CORRAL simply refuses the ball — 35.8 x 37.6 in behind 8.13 in panels is one
              // layer of 36 FUEL (§5.9.2). This is not a foul: G427 penalises off-FIELD FUEL that is
              // being *stored* beyond the CHUTE and CORRAL, and a ROBOT that cannot fit its load in
              // has kept it, not stored it. The HP's own forced-dump timer (see updateHuman) is where
              // that rule bites.
              if (pools[rb.alliance].corral >= FUEL.corralCapacity) break;
              for (let i = 0; i < total; i++) {
                if (fstate[i] === 3 && fholder[i] === rb.idx) {
                  storeInCorral(i, rb.alliance);
                  rb.carrying -= 1;
                  rb.stat.fuelDelivered += 1;
                  break;
                }
              }
            }
          }
          break;
        }
        case INTENT.CLIMB: {
          const spot = climbSpotFor(rb);
          if (Math.hypot(rb.x - spot.x, rb.y - spot.y) < 44) {
            if (!rb.climb.attaching) {
              rb.climb.attaching = true;
              rb.climb.attachClock = 0;
            }
            rb.climb.attachClock += tick;
            if (rb.climb.attachClock >= rb.climb.attachTimeSec) {
              rb.climb.progress = Math.min(1, rb.climb.progress + tick / Math.max(2, rb.climb.timeSec));
              if (rb.climb.progress >= 1 && !rb.climb.done) {
                rb.climb.done = true;
                completeClimb(rb, t);
              }
            }
          } else {
            rb.climb.attaching = false;
            rb.climb.attachClock = 0;
          }
          break;
        }
        default:
          // Scooping FUEL up on the way somewhere (this is deliberately weaker than the intake
          // action). Passive *pushing* of FUEL is separate: see bulldoze(), which runs for every
          // moving ROBOT regardless of intent. G408's blue box exempts inadvertent contact from
          // being CONTROL, so a ROBOT that happens to nudge FUEL is not "possessing" it.
          // A climbing or defending ROBOT is not intaking.
          if (
            rb.carrying < rb.capacity &&
            Math.hypot(rb.vx, rb.vy) > 30 &&
            !rb.climb.attaching &&
            intent.mode !== INTENT.DEFEND &&
            intent.mode !== INTENT.CLIMB
          ) {
            takeFuelNear(rb, 14, rb.intakeRate * 0.35, tick, (sc.intakeReach ?? MOUTH_REACH_IN) * 0.8);
          }
      }
      rb.stat.activeSec += tick;
    }

    // Every ROBOT is back inside the guardrails once the tick's interactions are done. The ROBOT-vs-
    // ROBOT shove above resolves two bodies against each other and is not itself checked against the
    // walls, so without this pass a shove can poke a ROBOT through the ALLIANCE WALL — and the
    // ALLIANCE WALL is the whole of the HUMAN PLAYER's protection (G421): the HP works in the OUTPOST
    // outside it, and nothing on the FIELD is allowed to reach that far.
    for (const rb of robots) {
      rb.x = clamp(rb.x, 6, GEO.L - 6);
      rb.y = clamp(rb.y, 6, GEO.W - 6);
    }

    // A ROBOT that can clear neither a BUMP nor a TRENCH cannot pass the band at all. navTarget
    // already refuses to route it across, but that test only fires while the ROBOT is still clear of
    // the band and aiming at the far side, and a shove can put it inside the band, where the test
    // silently stops applying and it would drive the whole FIELD. The constraint therefore lives on
    // the position itself, and is re-applied here rather than inline: the shove pass above moves a
    // ROBOT as a side effect of resolving ANOTHER one, so an inline clamp is not the last word.
    for (const rb of robots) {
      if (rb.canBump || rb.canTrench) continue;
      const band = GEO[rb.alliance].band;
      rb.x = rb.alliance === 'red' ? Math.min(rb.x, band[0] - 4) : Math.max(rb.x, band[1] + 4);
    }

    // ---- HUMAN PLAYER actions (§6.1, §5.9.2) ----
    // Each alliance's HP runs its own clock: swinging the CHUTE DOOR, draining the CHUTE onto the
    // FIELD, filling its hand from the CHUTE or the CORRAL, and throwing at its own HUB. Nothing here
    // touches a ROBOT, which is why the HP needs no collision handling of its own.
    for (const side of ['red', 'blue']) updateHuman(hps[side], t);

    // ---- FUEL in a hopper rides with its ROBOT ----
    // Without this a held ball keeps the position where it was picked up, so a shot (and the replay
    // tracer that draws it) would start from the far end of the FIELD instead of from the BUMPERS, and
    // the shot-block test would test a lane the ROBOT is not standing in. Skipped entirely when no
    // ROBOT is carrying and no ball is cooling down, so the usual case costs six comparisons.
    let anyCarry = false;
    for (const rb of robots) if (rb.carrying > 0) { anyCarry = true; break; }
    if (anyCarry || nointakeActive > 0) {
      for (let i = 0; i < total; i++) {
        if (fnointake[i] > 0) {
          fnointake[i] -= tick;
          if (fnointake[i] <= 0) {
            fnointake[i] = 0;
            nointakeActive -= 1;
          }
        }
        if (fstate[i] !== 3) continue;
        const rb = robots[fholder[i]];
        if (!rb) continue;
        const off = HELD_OFFSET[i % HELD_OFFSET.length];
        fx[i] = rb.x + off[0];
        fy[i] = rb.y + off[1];
      }
    }

    // ---- flight resolution, including the 3 s assessment grace (§6.5-A/B) ----
    for (const i of flights) {
      ftimer[i] -= tick;
      const x0 = fx[i];
      const y0 = fy[i];
      fx[i] += fvx[i] * tick;
      fy[i] += fvy[i] * tick;
      // A ROBOT standing in the lane stops the FUEL. This is the whole physical content of DEFEND: a
      // defender parked between a Dumper and its HUB takes those shots away rather than merely
      // slowing them down. Tested as a SWEPT SEGMENT, because at ~500 in/s a FUEL crosses a whole
      // ROBOT inside one tick and a point test would tunnel straight through it.
      const shooter = fshooter[i] >= 0 ? robots[fshooter[i]] : null;
      const blocker = shooter ? laneBlocker(shooter.alliance, x0, y0, fx[i], fy[i]) : null;
      if (blocker) {
        blockedFlight(i, shooter, blocker);
        continue;
      }
      if (ftimer[i] <= 0) resolveFlight(i, t);
    }
    // ---- HUB processing: scored FUEL reappears in the NEUTRAL ZONE (§5.4) ----
    for (const side of ['red', 'blue']) exitAcc[side] = Math.min(2, exitAcc[side] + hubExitRate * tick);
    for (const i of processing) {
      ftimer[i] -= tick;
      if (ftimer[i] > 0) continue;
      const target = fhub[i] === 1 ? 'red' : 'blue';
      // The exit rate, not the point award, is the real ceiling on a MATCH: FUEL that cannot get
      // back onto the FIELD yet stays inside the HUB, which is what starves a cycle late in a game.
      if (exitAcc[target] < 1) continue;
      exitAcc[target] -= 1;
      const hub = GEO[target].hub;
      const dir = target === 'red' ? 1 : -1;
      const land = placeLoose(i, hub.x + dir * (FIELD.hub.sizeIn / 2 + rng.range(15, 165)), hub.y + rng.range(-150, 150));
      fstate[i] = 0;
      fx[i] = land.x;
      fy[i] = land.y;
      processing.delete(i);
    }

    // The replay interpolates between recorded frames, so the recording is the display frame rate's
    // ceiling: at one frame per tick the anchors are 0.1 s apart and a ROBOT moving at 150 in/s turns
    // over 15 in between them, which is what makes interpolation look continuous instead of cutting
    // corners. FUEL is sub-sampled (every 4th ball, see sampleFuel) purely to keep the payload small.
    if (record && step % RECORD_EVERY_TICKS === 0) {
      timeline.push({
        t: +t.toFixed(2),
        p: period,
        hub: { red: hubActive('red', t), blue: hubActive('blue', t) },
        hp: { red: hpSnap(hps.red, 'red'), blue: hpSnap(hps.blue, 'blue') },
        fuel: sampleFuel(),
        r: robots.map((r) => ({
          i: r.idx,
          a: r.alliance,
          x: +r.x.toFixed(1),
          y: +r.y.toFixed(1),
          // Heading in radians. The ROBOT is a square now and a Dumper's shooter is on one face, so the
          // replay has to draw which way it is pointing rather than guess from its last movement.
          h: +r.heading.toFixed(2),
          c: r.carrying,
          m: r.intent.mode,
          k: r.climb.level,
          d: r.disabled ? 1 : 0,
        })),
        s: {
          red: totals('red'),
          blue: totals('blue'),
        },
      });
    }
  }

  // §6.5-B/D: assessment of FUEL and TELEOP TOWER points continues for up to 3 s after the
  // ARENA timer shows 0:00, so flights still airborne at 0:00 are drained here.
  for (let i = 0; i < total; i++) if (fstate[i] === 4) resolveFlight(i, TIME.matchSec);

  // The sampling stride above can leave the last frame short of the whistle, and the drain just
  // added points after it. Pin a final frame at the whistle so the replay ends on the real score.
  if (record) {
    timeline.push({
      t: TIME.matchSec,
      p: period,
      hub: { red: hubActive('red', TIME.matchSec), blue: hubActive('blue', TIME.matchSec) },
      hp: { red: hpSnap(hps.red, 'red'), blue: hpSnap(hps.blue, 'blue') },
      fuel: sampleFuel(),
      r: robots.map((r) => ({
        i: r.idx,
        a: r.alliance,
        x: +r.x.toFixed(1),
        y: +r.y.toFixed(1),
        h: +r.heading.toFixed(2),
        c: r.carrying,
        m: r.intent.mode,
        k: r.climb.level,
        d: r.disabled ? 1 : 0,
      })),
      s: {
        red: totals('red'),
        blue: totals('blue'),
      },
    });
  }

  function totals(side) {
    const s = score[side];
    return {
      fuel: s.fuel,
      tower: s.towerAuto + s.towerTeleop,
      fouls: s.foulPoints,
      total: s.fuel + s.towerAuto + s.towerTeleop + s.foulPoints,
    };
  }
  function sampleFuel() {
    // Each entry carries the FUEL's index as well as its position: the set of loose FUEL changes every
    // tick, so without an identity the replay could not tell "this ball moved" from "a different ball
    // is here now" and a linear blend between two frames would smear unrelated balls into each other.
    // EVERY ball on the FIELD is recorded — a viewer counts balls, and the old 1-in-4 sample of the
    // loose set drew a FIELD that looked a quarter as full as it was, which reads as a rendering bug.
    // FUEL in flight additionally carries its kind, its aim (element 3 = 4, element 4 = flight target:
    // 1 red HUB, 2 blue HUB, 3 a PASS aim point), how much flight it has left and who launched it. The
    // last two exist so the replay can draw ONE line per shooting ROBOT through the balls it has in the
    // air, oldest first: a turret firing on the move then shows the curve its own path traced, and a
    // turret standing still collapses to the single straight line the stream really is.
    const pts = [];
    for (let i = 0; i < total; i++) {
      const st = fstate[i];
      if (st === 0) pts.push([i, fx[i] | 0, fy[i] | 0]);
      else if (st === 4) pts.push([i, fx[i] | 0, fy[i] | 0, 4, fhub[i], +ftimer[i].toFixed(2), fshooter[i]]);
    }
    return pts;
  }

  const result = {
    final: {},
    autoFuel: { ...autoFuel },
    autoWinner,
    hubSchedule,
    events,
    timeline: record ? timeline : null,
    scenario: sc,
    robotStats: robots.map((r) => ({
      idx: r.idx,
      alliance: r.alliance,
      slot: r.slot,
      team: r.team,
      name: r.name,
      ...r.stat,
      distanceIn: Math.round(r.distance),
      health: r.health,
      pins: r.pins || r.stat.pins,
    })),
  };
  for (const side of ['red', 'blue']) {
    const s = score[side];
    result.final[side] = {
      fuel: s.fuel,
      fuelInactive: s.fuelInactive,
      // FUEL still sitting off the FIELD in the OUTPOST at the final whistle (§5.9.2). The CHUTE holds
      // what the HUMAN PLAYER never threw; the CORRAL holds what a ROBOT delivered and nobody threw.
      corral: pools[side].corral,
      chute: pools[side].chute,
      towerAuto: s.towerAuto,
      towerTeleop: s.towerTeleop,
      towerTotal: s.towerAuto + s.towerTeleop,
      foulPoints: s.foulPoints,
      total: totals(side).total,
    };
  }
  const th = POINTS.rpThreshold;
  for (const side of ['red', 'blue']) {
    const f = result.final[side];
    const energizedReq = sc.event === 'districtChamp' ? th.energized.districtChamp : th.energized.regional;
    const rp = {
      energized: f.fuel >= energizedReq ? 1 : 0,
      supercharged: f.fuel >= th.supercharged.regional ? 1 : 0,
      traversal: f.towerTotal >= th.traversal.regional ? 1 : 0,
      thresholds: { energized: energizedReq, supercharged: th.supercharged.regional, traversal: th.traversal.regional },
      result: 0,
    };
    const opp = result.final[other(side)].total;
    if (f.total === opp) rp.result = POINTS.rp.tie;
    else if (f.total > opp) rp.result = POINTS.rp.win;
    rp.total = rp.energized + rp.supercharged + rp.traversal + rp.result;
    f.rp = rp;
  }
  const redTotal = result.final.red.total;
  const blueTotal = result.final.blue.total;
  result.winner = redTotal === blueTotal ? 'tie' : redTotal > blueTotal ? 'red' : 'blue';
  return result;
}
