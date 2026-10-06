// Constants transcribed from the 2026 FIRST Robotics Competition Game Manual,
// "REBUILT presented by Haas", Version TU21 (2026GameManual.pdf supplied by the user).
// Every block cites the manual section / table / rule it came from so the site can
// show a rule-audit trail. Imperial units (inches, seconds, points) throughout,
// matching the manual's authoritative units (§1.6).

export const MANUAL = {
  game: 'REBUILT presented by Haas',
  season: '2026 FIRST Robotics Competition',
  version: 'TU21',
  pages: 166,
};

// §6.4 MATCH Periods + Table 6-2 MATCH SHIFTS. Total = 20 + 10 + 4*25 + 30 = 160 s (2:40).
export const TIME = {
  autoSec: 20, // Table 6-2: AUTO 0:20 -> 0:00
  transitionSec: 10, // Table 6-2: TRANSITION SHIFT 2:20 -> 2:10
  shiftSec: 25, // Table 6-2: SHIFT 1..4, 25 s each
  shiftCount: 4,
  endgameSec: 30, // Table 6-2: END GAME 0:30 -> 0:00
  matchSec: 160, // 2:40 (§6.1)
  hubDumpGraceSec: 3, // §6.5 Assessment of FUEL continues 3 s after a HUB deactivates
  autoScoreGraceSec: 3, // §6.5-A / §6.5-C
  teleopScoreGraceSec: 3, // §6.5-B / §6.5-D
};

// §6.4.1 + Table 6-3 "HUB Status during MATCH Timeframes".
// The ALLIANCE that scores more FUEL during AUTO has its HUB set INACTIVE for SHIFT 1, and
// statuses alternate each following ALLIANCE SHIFT; both HUBS are active in AUTO,
// TRANSITION SHIFT and END GAME. Equal AUTO FUEL -> FMS randomly picks (§6.4.1).
export function hubActiveTable(autoWinner) {
  const w = autoWinner; // 'red' | 'blue' | null(=FMS-random, resolved by caller)
  const active = { red: true, blue: true };
  const seq = [];
  const loser = w === 'red' ? 'blue' : 'red';
  seq.push({ period: 'AUTO', red: true, blue: true });
  seq.push({ period: 'TRANSITION', red: true, blue: true });
  for (let i = 0; i < 4; i++) {
    // SHIFT 1 and SHIFT 3 favour the AUTO loser; SHIFT 2 and SHIFT 4 favour the AUTO winner.
    const redActive = i % 2 === 0 ? loser === 'red' : w === 'red';
    seq.push({ period: `SHIFT ${i + 1}`, red: redActive, blue: !redActive });
  }
  seq.push({ period: 'END GAME', red: true, blue: true });
  void active;
  return seq;
}

// Table 6-4 REBUILT point values, Table 6-5 BONUS RP thresholds, Table 6-6 Rule violations.
export const POINTS = {
  fuelActiveHub: 1, // Table 6-4 (AUTO 1, TELEOP 1)
  // Table 6-4 prints LEVEL 1 as AUTO 15 / TELEOP 10 and LEVEL 2 / 3 as TELEOP 20 / 30.
  tower: { l1Auto: 15, l1Teleop: 10, l2Teleop: 20, l3Teleop: 30 },
  foul: { minor: 5, major: 15 }, // Table 6-6
  rp: { win: 3, tie: 1 }, // Table 6-4
  rpThreshold: {
    // Table 6-5
    energized: { regional: 100, districtChamp: 240 },
    supercharged: { regional: 360, districtChamp: 360 },
    traversal: { regional: 50, districtChamp: 50 },
  },
};

// §6.5.2 ROBOT Scoring Criteria.
// MANUAL CONFLICT, kept visible on purpose: §6.5.2 states "A ROBOT may only earn TOWER
// points for LEVEL 1 during AUTO", while Table 6-4 prints a TELEOP value of 10 for LEVEL 1.
// Verified that the conflict is present in the official FIRST manual build as well
// (same text on the same page), so it is not a transcription error here.
export const RULE_CONFLICTS = [
  {
    id: 'tower-l1-teleop',
    subject: 'TOWER LEVEL 1 in TELEOP',
    ruleText: '§6.5.2: "A ROBOT may only earn TOWER points for LEVEL 1 during AUTO."',
    tableText: 'Table 6-4: LEVEL 1 row prints AUTO 15 and TELEOP 10.',
    resolution:
      'Engine default follows Table 6-4 (the point-value table is the numeric authority) but exposes towerL1TeleopAllowed so a plan can be evaluated under the stricter reading.',
  },
  {
    id: 'tower-l3-auto-column',
    subject: 'TOWER LEVEL 3 AUTO column',
    tableText: 'Table 6-4 leaves the LEVEL 3 AUTO cell blank; §6.5.2 allows any single LEVEL during TELEOP only.',
    resolution: 'LEVEL 3 can only be earned in TELEOP.',
  },
];

// §6.3.4 SCORING ELEMENTS staging (504 FUEL) + §6.3.4.1 NEUTRAL ZONE arrangement.
export const FUEL = {
  stagedTotal: 504,
  perDepot: 24, // §6.3.4-A
  perChute: 24, // §6.3.4-B
  maxPreloadPerRobot: 8, // §6.3.4-C / G303-I
  chuteCapacity: 25, // §5.9.2 CHUTE holds approximately 25 FUEL
  neutralView: { widthIn: 206.0, depthIn: 72.0, dividerIn: 2.0 }, // §6.3.4.1
  diameterIn: 5.91, // §5.10.1
  massLb: 0.474, // §5.10.1: 0.448-0.500 lb
  wearTolerance: 24, // §6.3.4: NEUTRAL ZONE count may fluctuate +/- 24
  champTotal: 600, // §6.3.4: District/FIRST Championship may stage up to 600
};

// §5 ARENA dimensions. X runs red ALLIANCE WALL (0) -> blue ALLIANCE WALL (651.2),
// Y runs across the field (0 -> 317.7). Values are nominal (no tolerances implied, §5.1).
export const FIELD = {
  lengthIn: 651.2, // §5.2
  widthIn: 317.7, // §5.2
  centerLineXIn: 325.6, // §5.3 CENTER LINE bisects the NEUTRAL ZONE
  allianceZoneDepthIn: 158.6, // §5.3 ALLIANCE ZONE depth
  neutralZoneDepthIn: 283.0, // §5.3 NEUTRAL ZONE depth
  hub: {
    sizeIn: 47.0, // §5.4
    centerFromWallIn: 158.6, // §5.4 Figure 5-6
    openingFrontHeightIn: 72.0, // §5.4: front edge of opening 72 in off the carpet
    openingHexIn: 41.7, // §5.4 hexagonal opening
    exitCount: 4, // §5.4 four exits distributing FUEL into the NEUTRAL ZONE
    processingSec: 1.5, // modelling choice for HUB processing time (§6.5 permits a 3 s grace)
  },
  bump: {
    widthIn: 73.0, // §5.5
    depthIn: 44.4,
    heightIn: 6.513,
    rampDeg: 15,
    count: 4,
  },
  trench: {
    widthIn: 65.65, // §5.6
    depthIn: 47.0,
    heightIn: 40.25,
    clearWidthIn: 50.34, // opening under the TRENCH arm
    clearHeightIn: 22.25, // a ROBOT taller than this cannot drive under a TRENCH
    count: 4,
  },
  depot: { widthIn: 42.0, depthIn: 27.0 }, // §5.7
  tower: {
    widthIn: 49.25, // §5.8
    depthIn: 45.0,
    heightIn: 78.25,
    baseWidthIn: 39.0,
    baseDepthIn: 45.18,
    uprightHeightIn: 72.1,
    uprightGapIn: 32.25,
    rungLowIn: 27.0, // center of LOW RUNG off the floor
    rungMidIn: 45.0,
    rungHighIn: 63.0,
  },
  outpost: {
    openingWidthIn: 31.8, // §5.9.2 CHUTE upper opening
    openingHeightIn: 7.0,
    openingBottomIn: 28.1,
    corralOpeningWidthIn: 32.0, // §5.9.2 bottom opening ROBOTS push FUEL through
    corralOpeningHeightIn: 7.0,
    corralOpeningBottomIn: 1.88,
    corralWidthIn: 35.8,
    corralDepthIn: 37.6,
    corralWallHeightIn: 8.13,
  },
  driverStation: { count: 3, shelfWidthIn: 69.0, shelfDepthIn: 12.25 }, // §5.9.1
  guardrailHeightIn: 20.0, // §5.2
  aprilTags: { family: '36h11', count: 32, ids: '1-32', sizeIn: 8.125 }, // §5.11
};

// §8 ROBOT Construction Rules limits that constrain what a ROBOT can physically do.
export const ROBOT_LIMITS = {
  startPerimeterMaxIn: 110.0, // R104
  startHeightMaxIn: 30.0, // R104
  horizontalExtensionMaxIn: 12.0, // R105
  verticalHeightMaxIn: 30.0, // R107 (measured resting on a flat floor)
  weightMaxLb: 115.0, // R103
  weightWithBumpersMaxLb: 135.0, // R408
  bumperZoneLowIn: 2.5, // R405
  bumperZoneHighIn: 5.75, // R405
  bumperPaddingDepthIn: 2.25, // R402-A
  bumperPaddingHeightIn: 4.5, // R402-A
  bumperExtensionMaxIn: 4.0, // R403
  bumperHardPartMaxIn: 1.25, // R404
};

// Rule citations used by the site's rule-audit panel and by foul modelling.
export const RULES = [
  { id: '§6.4', text: 'AUTO 20 s, then TELEOP 2:20 split into TRANSITION, SHIFT 1-4 and END GAME.', engine: 'match clock + period state machine' },
  { id: 'Table 6-2', text: 'TRANSITION 10 s, each ALLIANCE SHIFT 25 s, END GAME 30 s.', engine: 'period boundaries' },
  { id: '§6.4.1 / Table 6-3', text: 'AUTO winner is INACTIVE for SHIFT 1 and SHIFT 3; both HUBs active in AUTO, TRANSITION and END GAME.', engine: 'hubActive()' },
  { id: 'Table 6-4', text: 'FUEL in an active HUB = 1 pt. TOWER LEVEL 1 = 15 (AUTO), LEVEL 2 = 20, LEVEL 3 = 30.', engine: 'scoreFuelAndTower()' },
  { id: '§6.5.2', text: 'L1 only in AUTO; one LEVEL per ROBOT during TELEOP; AUTO climb does not block a TELEOP climb.', engine: 'climb eligibility' },
  { id: 'Table 6-5', text: 'ENERGIZED RP at 100 (240 at DCMP), SUPERCHARGED RP at 360, TRAVERSAL RP at 50 TOWER points.', engine: 'rankingPoints()' },
  { id: 'Table 6-6', text: 'MINOR FOUL = 5 pts to the opponent, MAJOR FOUL = 15 pts to the opponent.', engine: 'foul accounting' },
  { id: '§6.3.4', text: '504 FUEL staged: 24 per DEPOT, 24 per CHUTE, up to 8 preloaded per ROBOT, remainder in the NEUTRAL ZONE.', engine: 'stageFuel()' },
  { id: '§6.3.4.1', text: 'NEUTRAL ZONE FUEL starts inside a ~206 x 72 in box straddling the CENTER LINE.', engine: 'stageFuel()' },
  { id: 'G303-I', text: 'A ROBOT may start while fully and solely supporting no more than 8 FUEL.', engine: 'preload cap' },
  { id: 'G407', text: 'A ROBOT may only launch FUEL into its HUB with its BUMPERS partly or fully inside its ALLIANCE ZONE.', engine: 'shoot legality gate' },
  { id: 'G408', text: 'A ROBOT may not catch or redirect FUEL released by the HUB except momentary contact.', engine: 'hub-exit dwell foul risk' },
  { id: 'G414', text: 'ROBOTS may not fully support the weight of ALLIANCE partners to climb.', engine: 'one ROBOT per TOWER footprint' },
  { id: 'G418', text: 'A PIN longer than 3 s is a MINOR FOUL, then a MAJOR FOUL for every further 3 s.', engine: 'pin timer' },
  { id: 'G419', text: 'Two or more ROBOTS may not work together to isolate or close off a major element of MATCH play.', engine: 'dual-corridor blocking check' },
  { id: 'G420', text: 'No contact with an opponent ROBOT touching its TOWER in the last 30 s; violation awards the opponent LEVEL 3.', engine: 'tower-protection window' },
  { id: 'G425', text: 'FUEL may only enter the FIELD through the CHUTE, the bottom OUTPOST opening, or thrown over the ALLIANCE WALL.', engine: 'human-player feed channel' },
  { id: 'G427', text: 'Off-FIELD FUEL may only be stored in the CHUTE and CORRAL; a full store must be entered immediately.', engine: 'human-player store limit' },
  { id: 'R104', text: 'STARTING CONFIGURATION: perimeter <= 110 in, height <= 30 in.', engine: 'trench clearance + start config' },
  { id: 'R107', text: 'ROBOTS may not extend such that total height exceeds 30 in (measured on a flat floor).', engine: 'climb geometry model' },
  { id: 'Table 10-1', text: 'Ranking: Ranking Score, then average MATCH points excluding fouls, then average AUTO FUEL, then average TOWER points.', engine: 'ranking sort' },
  { id: 'G208', text: 'A ROBOT that has passed inspection must have a DRIVE TEAM member at every assigned Qualification MATCH.', engine: 'no-show handling' },
];

export const FIELD_TYPE = { welded: 'Welded FIELD', andymark: 'AndyMark FIELD' }; // Table 5-1 / 5-2
