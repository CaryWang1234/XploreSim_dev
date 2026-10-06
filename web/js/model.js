// ROBOT capability model. Every field is something a scouting team can measure at an event,
// so a coach can type in real numbers instead of trusting presets. Presets are clearly
// labelled SAMPLE data in the UI, never presented as real team performance.

import { ROBOT_LIMITS, FIELD, TIME } from './rules.js';

export const DEFAULT_PROFILE = () => ({
  team: 0,
  name: '样品机器人',
  // Drive
  driveSpeedIps: 140, // top speed, inches/s
  accelIps2: 320,
  heightIn: 24, // STARTING CONFIGURATION height, R104 caps it at 30
  perimeterIn: 110, // R104 cap
  weightLb: 125, // R408 cap is 135 with bumpers
  // FUEL handling
  intakeRate: 2.6, // FUEL/s picked up while intaking
  capacity: 14, // FUEL controlled at once (no manual limit on CONTROL)
  shootRate: 1.6, // FUEL/s released while shooting
  shootAccuracy: 0.85, // P(scored) at the reference distance
  refShootDistanceIn: 60,
  accuracyFalloff: 0.0025, // accuracy lost per inch beyond the reference distance
  // TOWER
  climb: { l1: true, l2: true, l3: true, timeSec: 8, attachTimeSec: 2.5 },
  // AUTO routine quality
  auto: { fuelRate: 2.6, preloadShots: 8, accuracy: 0.75, climbLevel: 1, jitter: 0.12 },
  // Interaction
  defenseSkill: 0.5, // 0..1 how well it can deny an opponent
  defensePower: 0.5, // 0..1 pushing mass / drivetrain torque
  reliability: 0.97, // P(asset stays healthy for the whole MATCH)
});

export const ARCHETYPES = [
  {
    key: 'rush',
    label: '抢分型',
    hint: '几乎全员得分，极少防守',
    weights: { macroBias: { SCORE: 0.75, COLLECT: 0.15, DEFEND: 0.03, CLIMB: 0.07 }, aggression: 0.1, climbPriority: 0.4 },
  },
  {
    key: 'balanced',
    label: '均衡型',
    hint: '随换挡窗口调整得分与防守',
    weights: { macroBias: { SCORE: 0.55, COLLECT: 0.25, DEFEND: 0.1, CLIMB: 0.1 }, aggression: 0.35, climbPriority: 0.6 },
  },
  {
    key: 'defensive',
    label: '防守型',
    hint: '牺牲得分换取压制对手有效窗口',
    weights: { macroBias: { SCORE: 0.35, COLLECT: 0.2, DEFEND: 0.35, CLIMB: 0.1 }, aggression: 0.75, climbPriority: 0.3 },
  },
  {
    key: 'climber',
    label: '爬塔型',
    hint: '优先堆 TOWER 分与 TRAVERSAL RP',
    weights: { macroBias: { SCORE: 0.4, COLLECT: 0.2, DEFEND: 0.05, CLIMB: 0.35 }, aggression: 0.15, climbPriority: 1.0 },
  },
  {
    key: 'cycler',
    label: '循环型',
    hint: '高速取球-回冲循环，容量优先',
    weights: { macroBias: { SCORE: 0.65, COLLECT: 0.3, DEFEND: 0.0, CLIMB: 0.05 }, aggression: 0.05, climbPriority: 0.2 },
  },
];

export const SAMPLES = [
  {
    ...DEFAULT_PROFILE(),
    team: 101,
    name: '示例·疾风（循环）',
    driveSpeedIps: 175,
    intakeRate: 3.2,
    capacity: 22,
    shootRate: 3.0,
    shootAccuracy: 0.9,
    heightIn: 21.5, // fits under a TRENCH (22.25 in clearance, §5.6)
    weightLb: 128,
    climb: { l1: true, l2: true, l3: false, timeSec: 9, attachTimeSec: 2.4 },
    auto: { fuelRate: 3.4, preloadShots: 8, accuracy: 0.86, climbLevel: 1, jitter: 0.08 },
    defenseSkill: 0.4,
    defensePower: 0.45,
    reliability: 0.98,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 202,
    name: '示例·磐石（防守）',
    driveSpeedIps: 132,
    intakeRate: 2.2,
    capacity: 10,
    shootRate: 2.0,
    shootAccuracy: 0.78,
    heightIn: 28.5, // too tall for a TRENCH: must use BUMPS
    weightLb: 134,
    climb: { l1: true, l2: true, l3: true, timeSec: 7, attachTimeSec: 2.0 },
    auto: { fuelRate: 1.9, preloadShots: 8, accuracy: 0.7, climbLevel: 1, jitter: 0.16 },
    defenseSkill: 0.85,
    defensePower: 0.92,
    reliability: 0.99,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 303,
    name: '示例·云梯（爬塔）',
    driveSpeedIps: 126,
    intakeRate: 2.5,
    capacity: 13,
    shootRate: 2.3,
    shootAccuracy: 0.82,
    heightIn: 22.0,
    weightLb: 120,
    climb: { l1: true, l2: true, l3: true, timeSec: 5.5, attachTimeSec: 1.6 },
    auto: { fuelRate: 2.4, preloadShots: 8, accuracy: 0.8, climbLevel: 1, jitter: 0.1 },
    defenseSkill: 0.5,
    defensePower: 0.5,
    reliability: 0.97,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 404,
    name: '示例·全能',
    driveSpeedIps: 150,
    intakeRate: 2.9,
    capacity: 17,
    shootRate: 2.7,
    shootAccuracy: 0.88,
    heightIn: 23.5,
    weightLb: 130,
    climb: { l1: true, l2: true, l3: true, timeSec: 7, attachTimeSec: 2.2 },
    auto: { fuelRate: 3.0, preloadShots: 8, accuracy: 0.84, climbLevel: 1, jitter: 0.1 },
    defenseSkill: 0.65,
    defensePower: 0.6,
    reliability: 0.98,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 505,
    name: '示例·新秀',
    driveSpeedIps: 110,
    intakeRate: 1.8,
    capacity: 7,
    shootRate: 2.4,
    shootAccuracy: 0.62,
    heightIn: 26,
    weightLb: 112,
    climb: { l1: true, l2: false, l3: false, timeSec: 13, attachTimeSec: 4 },
    auto: { fuelRate: 1.2, preloadShots: 8, accuracy: 0.5, climbLevel: 0, jitter: 0.25 },
    defenseSkill: 0.25,
    defensePower: 0.3,
    reliability: 0.93,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 606,
    name: '示例·沉稳',
    driveSpeedIps: 142,
    intakeRate: 2.4,
    capacity: 14,
    shootRate: 2.2,
    shootAccuracy: 0.83,
    heightIn: 22.0,
    weightLb: 126,
    climb: { l1: true, l2: true, l3: true, timeSec: 9.5, attachTimeSec: 2.6 },
    auto: { fuelRate: 2.2, preloadShots: 8, accuracy: 0.74, climbLevel: 1, jitter: 0.14 },
    defenseSkill: 0.6,
    defensePower: 0.55,
    reliability: 0.97,
  },
];

// Derived capability: a ROBOT taller than the TRENCH clearance cannot drive under the
// TRENCH arm (§5.6 clear height 22.25 in) and must cross via a BUMP (§5.5, 6.513 in rise).
export function derived(p) {
  const trenchClear = FIELD.trench.clearHeightIn;
  return {
    canTrench: p.heightIn <= trenchClear,
    canBump: true,
    // R107 caps the deployed height at 30 in measured on a flat floor; climbing above the
    // 45 in MID RUNG is therefore a function of the climb mechanism, not of raw height.
    maxClimbLevel: p.climb.l3 ? 3 : p.climb.l2 ? 2 : p.climb.l1 ? 1 : 0,
    crossBandSec: FIELD.bump.depthIn / Math.max(20, p.driveSpeedIps * 0.55) + (p.canTrench ? 0 : 0.35),
  };
}

export function makeRobot(profile, alliance, slot) {
  const p = { ...DEFAULT_PROFILE(), ...profile };
  const d = derived(p);
  // Flatten the derived capabilities onto the ROBOT so the engine can query them directly.
  return { ...p, ...d, derived: d, alliance, slot };
}

export function makeAlliance(profiles, alliance) {
  return {
    alliance,
    robots: profiles.map((p, i) => makeRobot(p, alliance, i)),
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
    humanFeedRate: 1.6, // FUEL/s a HUMAN PLAYER can re-feed from CHUTE/CORRAL
    faultsEnabled: true,
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
