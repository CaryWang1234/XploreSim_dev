// ROBOT capability model. Every field is something a scouting team can measure at an event, so a
// coach can type in real numbers instead of trusting a preset.
//
// Presets come in two kinds, and the UI marks which is which:
//   - reference profiles for well-known programs (team number + nickname are public facts, all
//     performance numbers are estimates — see PRESET_PROVENANCE)
//   - generic sample profiles, which are plainly sample data
// Either way a preset is a starting point for a scenario, not a claim about a real ROBOT.

import { ROBOT_LIMITS, FIELD, TIME } from './rules.js';

// Two shooter architectures dominate this season, and they change how a cycle works. The gap is
// deliberate and measured: on the same profile, an all-turret ALLIANCE outscores an all-dumper one by
// about 25 points, where the older, gentler aim pair left the two within 2 points of each other.
//   turret  A rotating turret tracks the HUB, so the ROBOT fires from anywhere inside its own
//           ALLIANCE ZONE (G407) while it is still rolling, needing almost no time to come on target.
//           Shortest cycle: no trip to the HUB face and no settle.
//   dumper  A full-width shooter has to reach the HUB face, line up, and then wait out a much longer
//           spin-up before the whole hopper leaves at once. High burst, but every cycle ends parked
//           at the same spot and pays the longer aim.
export const MECHANISMS = [
  { key: 'turret', label: 'Turret', hint: 'Fires from anywhere in the ALLIANCE ZONE, on the move, with almost no aim time' },
  { key: 'dumper', label: 'Full-width Dumper', hint: 'Has to reach the HUB face and then waits a long spin-up before the whole hopper goes out' },
];

// Which face of the square the intake mouth is on. The ROBOT has a front now — the heading — and the
// mouth is a full-width slot on one face, so `deg` is the direction that face points, measured from
// the heading: the mouth's normal is heading + deg.
//
// It matters twice over. The mouth only swallows FUEL on the side it faces, and a ROBOT sweeps a pile
// by leading with the mouth, so a rear intake drives backwards into it (every chassis has a reverse,
// but a tank drive only reaches 60% of its top speed there) and a side intake has to strafe — which a
// tank drive cannot do at all, so a tank with a side intake keeps driving nose-first and only picks up
// what it brushes past. A Dumper whose shooter is on the front and whose intake is on the back pays a
// 180° turn between collecting and shooting, on top of the turn ramp.
//
// Back is the default because a Front mouth sits in the same 24 in as a front-mounted Dumper shooter:
// one bumper cannot hold both a roller and an opening, and on the FIELD they simply overlap.
export const INTAKE_SIDES = [
  { key: 'front', label: 'Front', deg: 0, hint: 'The mouth leads. Sweeps a pile driving forwards, which is the fastest way to cross the FIELD — but it shares that face with a Dumper shooter' },
  { key: 'back', label: 'Back', deg: 180, hint: 'The default, and the only face clear of a Dumper shooter. Sweeps a pile driving in reverse, at the chassis reverse fraction of top speed' },
  { key: 'left', label: 'Left side', deg: -90, hint: 'Needs a drivetrain that strafes. On a tank drive it only picks up what the side brushes past' },
  { key: 'right', label: 'Right side', deg: 90, hint: 'Needs a drivetrain that strafes. On a tank drive it only picks up what the side brushes past' },
];
export const INTAKE_SIDE_OF = (key) => INTAKE_SIDES.find((s) => s.key === key) || INTAKE_SIDES[0];

// The drivetrain decides which way the ROBOT can move, and now that the ROBOT is a square with a
// shooter that faces one way it decides when it can shoot as well.
//   swerve    four independently steered modules: translates in any direction without turning, and
//             spins in place. Turning is a separate act from driving, so the heading is free.
//   tank      two driven sides. It can only travel along its heading (forward, or reversed), so every
//             lateral move costs a turn first, and a turn costs speed.
//   mecanum   four angled rollers. Strafes without turning, but sideways it is slower than forwards
//             and the rollers slip, so a diagonal is worth less than either axis alone.
// `turn` is the fraction of the ROBOT's own 转向速度 it keeps while turning at speed, `lateral` the
// fraction of top speed it reaches sideways, `reverse` the fraction it reaches backing up. The engine
// reads them from CHASSIS_OF, not from the profile, so a chassis swap changes the kinematics wholesale.
//
// `turnRampSec` is the time the drivetrain needs to get from a standstill to its full spin rate, and
// it is what stops a ROBOT from flipping its heading in a single tick. A real one cannot: the spin has
// to be built up against the carpet and bled off again, so a turn is a trapezoid, not a jump. These
// three are ESTIMATES from what each drivetrain has to do physically, not measurements of a specific
// robot - the peak rates below are the ones a card can override.
export const CHASSIS = [
  {
    key: 'swerve',
    label: 'Swerve',
    turnRateDegPerSec: 540,
    turnRampSec: 0.25,
    lateral: 1,
    reverse: 1,
    turnAtSpeed: 1,
    hint: 'Translates in any direction and spins in place: heading is free, turning is not slowed by speed. 540 deg/s is traction-limited, not motor-limited, and it takes a quarter second to get there',
  },
  {
    key: 'tank',
    label: 'Tank drive',
    turnRateDegPerSec: 300,
    turnRampSec: 0.35,
    lateral: 0,
    reverse: 0.6,
    turnAtSpeed: 0.55,
    hint: 'Drives only along its heading (or reversed). Cannot strafe at all, and turning costs 45% of the turn rate at top speed',
  },
  {
    key: 'mecanum',
    label: 'Mecanum',
    turnRateDegPerSec: 200,
    turnRampSec: 0.3,
    lateral: 0.62,
    reverse: 0.78,
    turnAtSpeed: 0.75,
    hint: 'Strafes without turning, but sideways is 62% of top speed. Rotating in place is its weakest move: all four wheels scrub sideways, so it turns at a third of a swerve rate',
  },
];
export const CHASSIS_OF = (key) => CHASSIS.find((c) => c.key === key) || CHASSIS[0];

// Where a ROBOT starts the MATCH (§5.3 ROBOT STARTING LINE: the line "spans the width of the FIELD at
// the edge of an ALLIANCE ZONE in front of two BUMPS and an ALLIANCE HUB", and G303-D makes every
// ROBOT start with its BUMPERS overlapping it). Auto gives each DRIVER STATION one of the three
// structures that line runs in front of; the corner TRENCH lane is the alternative a team may prefer.
export const STARTS = [
  { key: 'auto', label: 'Auto (by station)', hint: 'Station 1 in front of a BUMP, 2 in front of the HUB, 3 in front of the other BUMP' },
  { key: 'bump', label: 'In front of a BUMP', hint: 'On the ROBOT STARTING LINE at a BUMP; the two BUMP lanes take one ROBOT each' },
  { key: 'trench', label: 'Under a TRENCH', hint: 'On the ROBOT STARTING LINE at the guardrail corner, where a TRENCH crosses the line' },
  { key: 'hub', label: 'In front of the HUB', hint: 'On the ROBOT STARTING LINE in front of the goal; a popular spot to open AUTO from' },
];

// The DRIVER is the person, not the machine: what they add is aim, how fast they get the mechanism
// onto the HUB, and how much they get out of the ROBOT on defence. Aim is a flat offset rather than a
// multiplier because a good driver cannot shoot better than the mechanism, and every reference ROBOT
// already sits at 0.92-0.93 - a multiplier would just pin them at 1.000 and delete the difference
// between equally good teams. `Average` is the reference the rest of the page is measured against, so
// a roster nobody touches behaves exactly as it did before this setting existed. Driving itself is
// not scaled: the engine's path following is closed-loop, so the "driver" in that loop is the
// controller, not a person.
export const DRIVERS = [
  { key: 'rookie', label: 'Rookie', aim: -0.1, aimTime: 1.5, defence: 0.75, hint: 'First season behind the glass: misses a tenth of the shots a reference driver makes, takes half again as long to line up, gets 25% less out of the ROBOT on defence' },
  { key: 'average', label: 'Average', aim: 0, aimTime: 1, defence: 1, hint: 'The reference the rest of the page is measured against: no change to aim, aim time or defence' },
  { key: 'good', label: 'Good', aim: 0.03, aimTime: 0.85, defence: 1.25, hint: 'Lines up in 85% of the reference time, +3% aim (capped at 0.99), 25% more defence pressure' },
  { key: 'elite', label: 'Elite', aim: 0.05, aimTime: 0.7, defence: 1.5, hint: 'A district-level driver: 70% of the reference aim time, +5% aim (capped at 0.99), 50% more defence pressure' },
];
export const DRIVER_OF = (key) => DRIVERS.find((d) => d.key === key) || DRIVERS[1];

// The 射程 fallback for a profile that never set one: see the field note in DEFAULT_PROFILE.
export const PASS_RANGE_DEFAULT_IN = 260;

export const DEFAULT_PROFILE = () => ({
  team: 0,
  name: 'Sample robot',
  mechanism: 'dumper',
  start: 'auto',
  // Drive
  driveSpeedIps: 140, // top speed, inches/s
  accelIps2: 320,
  // The ROBOT is a square, so which way it faces matters: a Dumper's shooter is bolted to one side and
  // can only fire when that side is turned toward the HUB, and the intake is a full-width slot on one
  // face. `turnRateDegPerSec` is how fast the heading can change; the defaults per chassis live in
  // CHASSIS and a preset may override them.
  chassis: 'swerve',
  turnRateDegPerSec: CHASSIS[0].turnRateDegPerSec,
  // Which face the intake mouth is on. Back is the default because a Front mouth and a front-mounted
  // Dumper shooter occupy the same bumper; see INTAKE_SIDES for what each face costs.
  intakeSide: 'back',
  heightIn: 24, // STARTING CONFIGURATION height, R104 caps it at 30
  perimeterIn: 110, // R104 cap; the engine's square footprint is perimeterIn/4 on a side
  weightLb: 125, // R408 cap is 135 with bumpers
  // FUEL handling. These are per-second rates at the mechanism, not MATCH averages: a modern
  // full-width intake sweeps FUEL far faster than the cycle rate, which is set by travel.
  intakeRate: 7.0, // FUEL/s picked up while intaking
  capacity: 30, // FUEL controlled at once (no manual limit on CONTROL)
  shootRate: 5.0, // FUEL/s released while shooting
  shootAccuracy: 0.85, // P(scored) at the reference distance
  refShootDistanceIn: 60,
  accuracyFalloff: 0.0025, // accuracy lost per inch beyond the reference distance
  // 射程 — how far a PASS actually carries. A shooter throws with one fixed punch, so an aim point
  // past this is simply not reached: the FUEL comes down short, on the same line, and becomes loose
  // FUEL wherever it landed. This is what makes the cross-FIELD pass a capability rather than a free
  // action. No rule caps it (§5.3 lets a ROBOT drive into the opponent's ALLIANCE ZONE from
  // TRANSITION on, and G407 only governs a launch INTO the HUB), so the only limit is the machine.
  // The geometry: the front edges of the two ALLIANCE ZONES are 334 in apart and their middle lines
  // 493 in, so a collector that is well inside the opponent's zone and wants to hand its load to a
  // partner in its own needs about 400-500 in of reach. 260 is a mid-power shooter: enough to reach a
  // partner waiting near midfield, not enough to reach home from the far zone.
  passRangeIn: PASS_RANGE_DEFAULT_IN,
  // Crossing the BUMP/TRENCH band between the ALLIANCE ZONE and the NEUTRAL ZONE. `null` follows the
  // height rule in derived(); set them explicitly to override it (a tall ROBOT that still clears the
  // TRENCH arm, or a short one the team keeps away from it).
  canBump: null,
  canTrench: null,
  // The three FUEL plays that are a choice rather than a capability, so turning one up is a
  // deliberate tactical decision by the user.
  //   passMode  off     never throw FUEL to a location instead of scoring it
  //             auto    throw to a partner already back on our half when that is a real shortcut, and
  //                     to open ground in our own ALLIANCE ZONE when nobody is home to take the load
  //             eager   the same two targets, but the hopper only has to be worth a throw rather than
  //                     nearly full, and the saving it must clear is 60 in instead of 150
  // Either way the target has to be inside `passRangeIn`: a throw past the reach lands short of the
  // partner, so the range is what decides which ROBOTS get to pass across the FIELD at all.
  //   pushMode  off     never shove loose FUEL
  //             passive FUEL that the BUMPER happens to hit gets shoved (physics only)
  //             active  deliberately drive through a pile from the far side to herd it toward our half
  //   feedMode  off     never hand a load to the OUTPOST
  //             auto    while our own HUB is dark, push a load that cannot score into the CORRAL for
  //                     the HUMAN PLAYER to throw (§5.9.2: "ROBOTs can push FUEL into the CORRAL")
  passMode: 'auto',
  pushMode: 'passive',
  feedMode: 'auto',
  // TOWER. timeSec is the climb duration once attached; a ROBOT with no climb mechanism leaves
  // l1/l2/l3 false and never climbs, which is the common case on top-tier ROBOTs.
  climb: { l1: true, l2: true, l3: true, timeSec: 8, attachTimeSec: 2.5 },
  // AUTO routine quality
  auto: { fuelRate: 7.0, preloadShots: 8, accuracy: 0.75, climbLevel: 1, jitter: 0.12 },
  // Interaction
  defenseSkill: 0.5, // 0..1 how well it can deny an opponent
  defensePower: 0.5, // 0..1 pushing mass / drivetrain torque
  reliability: 0.97, // P(asset stays healthy for the whole MATCH)
  // The person in the box, and whether this ROBOT takes the field at all. `plays: false` is the
  // bench: a benched ROBOT is not fielded, so it has no start position, no preload and nothing to
  // collide with, and the DRIVER STATIONS close up around it (two ROBOTs are stations 1 and 2).
  // That is how a 1v1 is set up.
  driver: 'average',
  plays: true,
});

export const ARCHETYPES = [
  {
    key: 'rush',
    label: 'Rusher',
    hint: 'Almost everyone scores, rarely defends',
    weights: { macroBias: { SCORE: 0.75, COLLECT: 0.15, DEFEND: 0.03, CLIMB: 0.07 }, aggression: 0.1, climbPriority: 0.4 },
  },
  {
    key: 'balanced',
    label: 'Balanced',
    hint: 'Shifts between scoring and defence with the windows',
    weights: { macroBias: { SCORE: 0.55, COLLECT: 0.25, DEFEND: 0.1, CLIMB: 0.1 }, aggression: 0.35, climbPriority: 0.6 },
  },
  {
    key: 'defensive',
    label: 'Defensive',
    hint: "Trades scoring to shut down the opponent's windows",
    weights: { macroBias: { SCORE: 0.35, COLLECT: 0.2, DEFEND: 0.35, CLIMB: 0.1 }, aggression: 0.75, climbPriority: 0.3 },
  },
  {
    key: 'climber',
    label: 'Climber',
    hint: 'Stacks TOWER points and TRAVERSAL RP',
    weights: { macroBias: { SCORE: 0.4, COLLECT: 0.2, DEFEND: 0.05, CLIMB: 0.35 }, aggression: 0.15, climbPriority: 1.0 },
  },
  {
    key: 'cycler',
    label: 'Cycler',
    hint: 'Fast collect-and-return cycles, hopper first',
    weights: { macroBias: { SCORE: 0.65, COLLECT: 0.3, DEFEND: 0.0, CLIMB: 0.05 }, aggression: 0.05, climbPriority: 0.2 },
  },
];

// ---------------------------------------------------------------------------------------------
// Reference profiles modelled on well-known FRC programs.
//
// PROVENANCE — read this before quoting a number:
//   identity  The team numbers and nicknames are public, widely known facts.
//   params    Every performance number below is an ESTIMATE. It exists to reproduce that
//             program's publicly visible playstyle (cycle speed, shot volume, climb speed,
//             defensive presence) so a coach can set up a realistic opponent. None of it is
//             measured data, none of it is confirmed by any team, and none of it is a
//             prediction about how any of these teams would actually play REBUILT.
//   Use the sample profiles for generic partners, and type your own scouting numbers for anything
//   you intend to act on.
// ---------------------------------------------------------------------------------------------
export const PRESET_PROVENANCE = {
  sourced: 'Every reference robot has a source link. What can be read straight from the source is filled in (1678 full-width shooter + climbs L1, 1690 turret + about 13 BPS + climbs L1, 4414 turret + 85-ball hopper, 5940 4.5-ball-wide shooter + no climb, 254 no climb); everything else is estimated.',
  params: "Most numbers are still estimates: those the source states (4414's 85+ ball hopper, 1690's 13 BPS) are used directly, and the rest are inferred from similar machines, unconfirmed by the teams.",
};

export const SAMPLES = [
  {
    ...DEFAULT_PROFILE(),
    team: 254,
    name: 'Chezy',
    ref: 'Overload: the reveal thread confirms there is no climb mechanism; the shooter is not described publicly (the thread mentions a belt indexer), so it is estimated as a full-width shooter.',
    source: 'https://www.chiefdelphi.com/t/team-254-presents-overload/516252',
    mechanism: 'dumper',
    driveSpeedIps: 180,
    intakeRate: 12.0,
    capacity: 65,
    shootRate: 10.0,
    shootAccuracy: 0.92,
    passRangeIn: 380,
    heightIn: 21.5,
    weightLb: 128,
    climb: { l1: false, l2: false, l3: false, timeSec: 0, attachTimeSec: 0 },
    auto: { fuelRate: 11.0, preloadShots: 8, accuracy: 0.9, climbLevel: 0, jitter: 0.05 },
    defenseSkill: 0.5,
    defensePower: 0.5,
    reliability: 0.99,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 1678,
    name: 'Citrus',
    ref: 'Limestone: full-width shooter (25 in between the side plates, the full robot width), climbs L1, strongest autonomous of the year (two autonomous awards that season)',
    source: 'https://www.citruscircuits.org/2026-robot',
    mechanism: 'dumper',
    driveSpeedIps: 175,
    intakeRate: 11.0,
    capacity: 55,
    shootRate: 10.5,
    shootAccuracy: 0.94,
    passRangeIn: 420,
    heightIn: 22.0, // 27x27in SDS MK5n frame, fits the TRENCH
    weightLb: 130,
    // Source: "climb to Level 1 with ease". §6.5.2 only requires L1 to stop touching the carpet or
    // TOWER BASE, so it is a small lift and the time is short. A long time would make the search
    // conclude that climbing loses to another FUEL cycle, which is the opposite of the truth.
    climb: { l1: true, l2: false, l3: false, timeSec: 3, attachTimeSec: 2 },
    auto: { fuelRate: 11.0, preloadShots: 8, accuracy: 0.93, climbLevel: 1, jitter: 0.04 },
    defenseSkill: 0.62,
    defensePower: 0.62,
    reliability: 0.995,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 1690,
    name: 'Orbit',
    ref: 'Kepler: turret, shoots on the move; someone in the thread counted about 13 BPS frame by frame; takes the TRENCH, climbs L1 (picks L1 over L3 on purpose)',
    source: 'https://www.chiefdelphi.com/t/orbit-1690-2026-robot-reveal-kepler/515277',
    mechanism: 'turret',
    driveSpeedIps: 172,
    intakeRate: 13.0,
    capacity: 45,
    shootRate: 13.0, // measured at 13 BPS in the thread
    shootAccuracy: 0.95,
    passRangeIn: 520, // the cross-FIELD passer of this set: reaches its own ALLIANCE ZONE from inside theirs
    heightIn: 21.5, // the thread discusses choosing the TRENCH over the BUMP
    weightLb: 124,
    climb: { l1: true, l2: false, l3: false, timeSec: 3, attachTimeSec: 2 }, // L1 = leaving the carpet is enough (§6.5.2)
    auto: { fuelRate: 12.0, preloadShots: 8, accuracy: 0.9, climbLevel: 1, jitter: 0.06 },
    defenseSkill: 0.5,
    defensePower: 0.5,
    reliability: 0.99,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 4414,
    name: 'Tide',
    ref: 'RipCurrent: turret (55.7:1, tilt compensation, can fire while defended on the BUMP); hopper 85+ (TRENCH) / 100+ (BUMP); no climb section',
    source: 'https://2026.team4414.com/',
    mechanism: 'turret',
    driveSpeedIps: 170,
    intakeRate: 12.0,
    capacity: 85, // source: "Extending hopper holds 85+ balls under the trench, 100+ with net over the bump"
    shootRate: 11.0,
    shootAccuracy: 0.93,
    passRangeIn: 480,
    heightIn: 21.5, // starting configuration has to fit under the TRENCH
    weightLb: 126,
    climb: { l1: false, l2: false, l3: false, timeSec: 0, attachTimeSec: 0 },
    auto: { fuelRate: 11.0, preloadShots: 8, accuracy: 0.9, climbLevel: 0, jitter: 0.07 },
    defenseSkill: 0.55,
    defensePower: 0.55,
    reliability: 0.985,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 5940,
    name: 'BREAD',
    ref: 'Lemon Puff: 4.5-ball-wide shooter with an adjustable hood (full-width class, not a turret); 25.5 in single-roller intake plus a juicer expander; no climb in the subsystem list',
    source: 'https://technicalbinder.team5940.org/',
    mechanism: 'dumper',
    driveSpeedIps: 158,
    intakeRate: 11.0,
    capacity: 55,
    shootRate: 9.5,
    shootAccuracy: 0.9,
    passRangeIn: 300,
    heightIn: 23.5, // the source stresses smooth traversal of the BUMP
    weightLb: 132,
    climb: { l1: false, l2: false, l3: false, timeSec: 0, attachTimeSec: 0 },
    auto: { fuelRate: 8.5, preloadShots: 8, accuracy: 0.86, climbLevel: 0, jitter: 0.08 },
    defenseSkill: 0.86,
    defensePower: 0.88,
    reliability: 0.995,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 11019,
    name: 'Xplore',
    ref: 'Celestial Pivot: 360° turret with 2× Kraken X60 flywheels (1:1) and a 25° hood; front low dual-roller intake on 2× Kraken X44 (1:3); telescoping hopper on a PC plate; 4" MK5R swerve, top speed 4.58 m/s (180 in/s). The drivetrain, ratios and layout are from the binder; intake rate, hopper capacity, shoot rate, accuracy and height are not stated there and are estimated here. No climb: the game analysis keeps every second in the FUEL cycle, and the labelled subsystem diagram has no climber.',
    source: 'Team 11019 2026 Sanya tech binder (11019-2026Sanya-TechBinder-ZH.pdf)',
    mechanism: 'turret',
    driveSpeedIps: 180,
    chassis: 'swerve', // binder: 4" MK5R swerve
    turnRateDegPerSec: 540,
    intakeRate: 12.0,
    capacity: 55,
    shootRate: 10.5,
    shootAccuracy: 0.92,
    passRangeIn: 460,
    heightIn: 22.0,
    weightLb: 128,
    climb: { l1: false, l2: false, l3: false, timeSec: 0, attachTimeSec: 0 },
    auto: { fuelRate: 10.0, preloadShots: 8, accuracy: 0.9, climbLevel: 0, jitter: 0.06 },
    defenseSkill: 0.5,
    defensePower: 0.5,
    reliability: 0.99,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 9991,
    name: 'Sample · Swift (cycler)',
    mechanism: 'turret',
    driveSpeedIps: 175,
    intakeRate: 10.0,
    capacity: 45,
    shootRate: 8.5,
    shootAccuracy: 0.9,
    passRangeIn: 300,
    heightIn: 21.5, // fits under a TRENCH (22.25 in clearance, §5.6)
    weightLb: 128,
    climb: { l1: true, l2: true, l3: false, timeSec: 9, attachTimeSec: 2.4 },
    auto: { fuelRate: 8.5, preloadShots: 8, accuracy: 0.86, climbLevel: 1, jitter: 0.08 },
    defenseSkill: 0.4,
    defensePower: 0.45,
    reliability: 0.98,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 9992,
    name: 'Sample · Bulwark (defensive)',
    mechanism: 'dumper',
    driveSpeedIps: 132,
    chassis: 'tank',
    turnRateDegPerSec: 300,
    intakeRate: 7.0,
    capacity: 32,
    shootRate: 6.0,
    shootAccuracy: 0.78,
    passRangeIn: 200,
    heightIn: 28.5, // too tall for a TRENCH: must use BUMPS
    weightLb: 134,
    climb: { l1: true, l2: true, l3: true, timeSec: 7, attachTimeSec: 2.0 },
    auto: { fuelRate: 5.5, preloadShots: 8, accuracy: 0.7, climbLevel: 1, jitter: 0.16 },
    defenseSkill: 0.85,
    defensePower: 0.92,
    reliability: 0.99,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 9993,
    name: 'Sample · Ladder (climber)',
    mechanism: 'dumper',
    driveSpeedIps: 126,
    chassis: 'swerve',
    turnRateDegPerSec: 460, // a tall climber turns more conservatively than a flat cycler
    intakeRate: 7.0,
    capacity: 35,
    shootRate: 6.5,
    shootAccuracy: 0.82,
    passRangeIn: 220,
    heightIn: 22.0,
    weightLb: 120,
    climb: { l1: true, l2: true, l3: true, timeSec: 5.5, attachTimeSec: 1.6 },
    auto: { fuelRate: 6.0, preloadShots: 8, accuracy: 0.8, climbLevel: 1, jitter: 0.1 },
    defenseSkill: 0.5,
    defensePower: 0.5,
    reliability: 0.97,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 9994,
    name: 'Sample · All-round',
    mechanism: 'turret',
    driveSpeedIps: 150,
    chassis: 'swerve',
    turnRateDegPerSec: 540,
    intakeRate: 8.5,
    capacity: 40,
    shootRate: 7.0,
    shootAccuracy: 0.88,
    heightIn: 23.5,
    weightLb: 130,
    climb: { l1: true, l2: true, l3: true, timeSec: 7, attachTimeSec: 2.2 },
    auto: { fuelRate: 7.0, preloadShots: 8, accuracy: 0.84, climbLevel: 1, jitter: 0.1 },
    defenseSkill: 0.65,
    defensePower: 0.6,
    reliability: 0.98,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 9995,
    name: 'Sample · Rookie (weak)',
    mechanism: 'dumper',
    driveSpeedIps: 110,
    chassis: 'tank',
    turnRateDegPerSec: 240,
    intakeRate: 4.0,
    capacity: 16,
    shootRate: 4.5,
    shootAccuracy: 0.62,
    passRangeIn: 140,
    heightIn: 26,
    weightLb: 112,
    climb: { l1: true, l2: false, l3: false, timeSec: 6, attachTimeSec: 3 }, // rookie team: even L1 is slow
    auto: { fuelRate: 3.0, preloadShots: 8, accuracy: 0.5, climbLevel: 0, jitter: 0.25 },
    defenseSkill: 0.25,
    defensePower: 0.3,
    reliability: 0.93,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 9996,
    name: 'Sample · Steady (mid)',
    mechanism: 'dumper',
    driveSpeedIps: 142,
    chassis: 'mecanum',
    turnRateDegPerSec: 200, // mecanum spin is traction-bound: four wheels scrubbing sideways
    intakeRate: 7.5,
    capacity: 36,
    shootRate: 6.5,
    shootAccuracy: 0.83,
    heightIn: 22.0,
    weightLb: 126,
    climb: { l1: true, l2: true, l3: true, timeSec: 9.5, attachTimeSec: 2.6 },
    auto: { fuelRate: 6.5, preloadShots: 8, accuracy: 0.74, climbLevel: 1, jitter: 0.14 },
    defenseSkill: 0.6,
    defensePower: 0.55,
    reliability: 0.97,
  },
];

// Derived capability: a ROBOT taller than the TRENCH clearance cannot drive under the TRENCH arm
// (§5.6 clear height 22.25 in) and must cross via a BUMP (§5.5, 6.513 in rise). Height only decides
// what the ROBOT *can* clear, though, so both crossings are settable on the profile and `null` means
// "follow the height rule". `fitsTrench` is reported separately so a UI can say when an override
// contradicts the build.
export function derived(p) {
  const trenchClear = FIELD.trench.clearHeightIn;
  const fitsTrench = p.heightIn <= trenchClear;
  const canTrench = p.canTrench == null ? fitsTrench : !!p.canTrench;
  const canBump = p.canBump == null ? true : !!p.canBump;
  const ch = CHASSIS_OF(p.chassis);
  return {
    fitsTrench,
    canTrench,
    canBump,
    // Square footprint: R104 caps the STARTING CONFIGURATION perimeter at 110 in, so a square ROBOT is
    // 27.5 in on a side and its half-width is perimeter/8. The engine's collision, the intake mouth band
    // and the Dumper's shooting face are all measured from this box.
    footprintHalfIn: Math.max(8, (p.perimeterIn || 110) / 8),
    // Chassis kinematics flattened onto the ROBOT so the engine reads numbers, not a lookup.
    chassisKey: ch.key,
    chassisLateral: ch.lateral,
    chassisReverse: ch.reverse,
    chassisTurnAtSpeed: ch.turnAtSpeed,
    turnRateDegPerSec: p.turnRateDegPerSec > 0 ? p.turnRateDegPerSec : ch.turnRateDegPerSec,
    // Peak spin rate is not the same as how fast a ROBOT reaches it. This is the resolved rate over the
    // chassis's ramp time, in deg/s^2, and the engine integrates the heading against it, so a turn takes
    // as long as it does on a real drivetrain instead of snapping on one tick.
    turnAccelDegPerSec2: (p.turnRateDegPerSec > 0 ? p.turnRateDegPerSec : ch.turnRateDegPerSec) / Math.max(0.05, ch.turnRampSec || 0.3),
    // Bearing of the intake mouth measured from the heading. The engine rotates the intake cone by this
    // and, when the ROBOT is driving to collect, turns the car so the mouth leads.
    intakeOffsetDeg: INTAKE_SIDE_OF(p.intakeSide).deg,
    // Resolved here rather than left on the profile so the engine and the policy read one number that
    // is always a real reach, whatever the card or a hand-built script profile held.
    passRangeIn: p.passRangeIn > 0 ? p.passRangeIn : PASS_RANGE_DEFAULT_IN,
    // R107 caps the deployed height at 30 in measured on a flat floor; climbing above the
    // 45 in MID RUNG is therefore a function of the climb mechanism, not of raw height.
    maxClimbLevel: p.climb.l3 ? 3 : p.climb.l2 ? 2 : p.climb.l1 ? 1 : 0,
    crossBandSec: FIELD.bump.depthIn / Math.max(20, p.driveSpeedIps * 0.55) + (canTrench ? 0 : 0.35),
  };
}

export function makeRobot(profile, alliance, slot) {
  const p = { ...DEFAULT_PROFILE(), ...profile };
  const d = derived(p);
  const dr = DRIVER_OF(p.driver);
  // Flatten the derived capabilities onto the ROBOT so the engine can query them directly, and fold
  // the DRIVER into the three things a person actually controls. Applied to the ROBOT, not left on the
  // profile, so the engine, the AI's capability list and the replay all read the same effective
  // numbers while the card keeps showing the base specs the user typed.
  return {
    ...p,
    ...d,
    shootAccuracy: Math.min(0.99, p.shootAccuracy + dr.aim),
    defenseSkill: Math.min(1, p.defenseSkill * dr.defence),
    defensePower: Math.min(1, p.defensePower * dr.defence),
    aimFactor: dr.aimTime,
    derived: d,
    alliance,
    slot,
  };
}

export function makeAlliance(profiles, alliance) {
  // ROBOTs that are not on the field are not fielded at all. Filtering here rather than in the engine
  // keeps every caller honest: the engine, the AI's capability list (capOf), the Monte-Carlo worker
  // and the replay all build their ROBOTs through this one function.
  const fielded = profiles.filter((p) => ({ ...DEFAULT_PROFILE(), ...p }).plays !== false);
  return {
    alliance,
    robots: fielded.map((p, i) => makeRobot(p, alliance, i)),
    driveCoach: { riskTolerance: 0.5, rpFocus: 'win' },
  };
}

// Match-level scenario knobs that a coach would set before running the tool.
export function defaultScenario() {
  return {
    autoWinner: 'auto', // 'auto' | 'red' | 'blue' - 'auto' resolves from simulated AUTO FUEL
    event: 'regional', // 'regional' | 'districtChamp' -> Table 6-5 thresholds
    objective: 'rs', // 'rs' (Ranking Score, qualification) | 'win' (playoff)
    towerL1TeleopAllowed: true, // see RULE_CONFLICTS['tower-l1-teleop']
    fuelTotal: 504, // §6.3.4, up to 600 at DCMP / FIRST Championship
    // The HUMAN PLAYER's two variables: how fast they can throw FUEL at their own HUB to score
    // (§6.1 "HUMAN PLAYERS can deliver FUEL to ROBOTS or score them in their HUB"), and how often
    // that throw goes in. Both are per side, because they are different people. Everything else
    // about the role is fixed by the OUTPOST rules (G423 reach, G425 delivery paths, G427 storage).
    // 0.4 throws/s is one FUEL every 2.5 s, which is a plausible chute-to-HUB cycle for one person
    // and leaves part of the 24-FUEL CHUTE for a dump instead of throwing it all inside AUTO.
    humanThrowPerSec: { red: 0.4, blue: 0.4 },
    humanAccuracy: { red: 0.75, blue: 0.75 },
    // FUEL/s a HUB can push back into the NEUTRAL ZONE through its four exits (§5.4). A HUB has to
    // route every FUEL it receives through its scoring mechanism and out again, so its exit path is
    // a finite bottleneck, and FUEL that cannot leave yet stays inside it. This is the calibrated
    // knob, not a free parameter: real 2026 Einstein Finals ALLIANCES averaged 627 points a MATCH
    // (406 / 456 / 518 / 561 / 711 / 712 across F1 M1-M3, event average 627, high 842, from The Blue
    // Alliance), and with only 504 FUEL on the FIELD (§6.3.4) an ALLIANCE can only reach that by
    // recirculating FUEL about once a MATCH. The 0.1 s kinematic engine has no other ceiling on
    // tempo, so without this every ALLIANCE cycles a fountain and roughly doubles the real score.
    // Verified against the greedy mirror (scripts/mirror.mjs, n=24 x 2 seed sets x both trios). On the
    // shipped build that mirror reads 591.7 with its red-minus-blue split inside its own error bar
    // (0.4 +- 6.2); the 615.7 the knob was originally backed out from belongs to an earlier layout.
    // Swept on the build before the lanes: 4.0 -> 598.6, 4.2 -> 615.7, 4.4 -> 614.7, 4.6 -> 622.5, and
    // the sweep stopped at 4.2 because past it the mirror developed a side gap (4.4: red-blue -14.8 +-
    // 6.5, 4.6: -21.9 +- 7.3) that was not yet explained, so the cap stopped where the MATCHes still
    // scored evenly. 4.0 kept both in range too, at 4.5% under the real average; the value was re-derived
    // after the NEUTRAL ZONE layout was made point-symmetric, which took about 20 points out of each.
    // Re-swept on the build that models the BUMP/TRENCH seam (§5.5/§5.6), same harness, n=192 each:
    // 4.2 -> 594.7, 4.4 -> 611.6, 4.6 -> 611.2, 4.8 -> 615.5, 5.0 -> 618.5, 5.2 -> 627.0, 5.4 -> 627.8,
    // 5.6 -> 633.4. The seam took about 16 points off the whole curve without touching the cap's leverage,
    // and the side gap that used to stop the sweep at 4.2 did not reproduce: across those values the
    // red-blue split is -3.4, -5.3, -11.4, +1.4, -1.5, -9.9, none past 2 sem — what had been making a
    // mirror favour a seat was a ROBOT sliding sideways across a seam to get home.
    // Re-swept once more after a launch was given a dispersion: 4.2 -> 593.4, 4.6 -> 600.6, 5.0 -> 616.3,
    // 5.2 -> 613.4 (n=192). Re-swept a third time after the face clamp was limited to misses, which is the
    // build that ships: 4.2 -> 592.6, 4.6 -> 602.3, 5.0 -> 613.2, 5.2 -> 614.6 (n=192). The fan costs about
    // a point at the shipped cap and the curve flattens near 615 rather than reaching 627, so 5.0 would put
    // the anchor 2.2% under the real average - only at the edge of the band, and it was 1.7% on the build
    // before - and it is still not shipped. A knob with no independent measurement is not free to move:
    // every measured figure on the page is anchored on it, and retuning it is how the cost of a rule change
    // gets erased instead of reported. 4.2 ships and the shortfall is stated where it is read.
    hubExitRate: 4.2,
    faultsEnabled: true,
    // §7.4.4 G415/G416/G417 (opponent interaction) are off by default. The rules are real, but the one
    // number they need - how often a hard collision actually damages a ROBOT - has no real-world anchor
    // here, and turning it on changes the calibrated baseline, so it is a switch in Setup rather than a
    // silent part of the engine. The thresholds it does not invent (impact severity, where the contact
    // happened, whether it was deliberate) are measured; see web/js/engine.js.
    contactFouls: false,
    seed: 20260110, // 2026 Kickoff date (§1.3)
    chunkSec: 0.1, // simulation tick
  };
}

export const PERIOD_ORDER = ['AUTO', 'TRANSITION', 'SHIFT 1', 'SHIFT 2', 'SHIFT 3', 'SHIFT 4', 'END GAME'];

export function periodAt(t) {
  if (t < TIME.autoSec) return 'AUTO';
  let r = t - TIME.autoSec;
  if (r < TIME.transitionSec) return 'TRANSITION';
  r -= TIME.transitionSec;
  const s = Math.floor(r / TIME.shiftSec);
  if (s < TIME.shiftCount) return `SHIFT ${s + 1}`;
  return 'END GAME';
}

export function periodWindow(period) {
  const a = TIME.autoSec;
  const tr = a + TIME.transitionSec;
  switch (period) {
    case 'AUTO':
      return [0, a];
    case 'TRANSITION':
      return [a, tr];
    case 'END GAME':
      return [tr + TIME.shiftSec * TIME.shiftCount, TIME.matchSec];
    default: {
      const i = Number(String(period).split(' ')[1]) - 1;
      return [tr + i * TIME.shiftSec, tr + (i + 1) * TIME.shiftSec];
    }
  }
}

export function maxFoulFreeHeight() {
  return ROBOT_LIMITS.verticalHeightMaxIn;
}
