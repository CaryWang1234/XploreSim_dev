// ROBOT capability model. Every field is something a scouting team can measure at an event, so a
// coach can type in real numbers instead of trusting a preset.
//
// Presets come in two kinds, and the UI marks which is which:
//   - reference profiles for well-known programs (team number + nickname are public facts, all
//     performance numbers are estimates — see PRESET_PROVENANCE)
//   - generic 示例 profiles, which are plainly sample data
// Either way a preset is a starting point for a scenario, not a claim about a real ROBOT.

import { ROBOT_LIMITS, FIELD, TIME } from './rules.js';

// Two shooter architectures dominate this season, and they change how a cycle works:
//   turret  A rotating turret tracks the HUB, so the ROBOT can fire from anywhere inside its own
//           ALLIANCE ZONE (G407) without lining up. Shorter cycle: no trip to the HUB face.
//   dumper  A full-width shooter has to face the HUB and dump a whole load at once. High burst,
//           but every cycle ends parked at the same spot.
export const MECHANISMS = [
  { key: 'turret', label: '炮塔 Turret', hint: 'ZONE 内任意位置可射，不必对准 HUB' },
  { key: 'dumper', label: '全宽 Dumper', hint: '必须开到 HUB 前对准后倾泻' },
];

export const DEFAULT_PROFILE = () => ({
  team: 0,
  name: '样品机器人',
  mechanism: 'dumper',
  // Drive
  driveSpeedIps: 140, // top speed, inches/s
  accelIps2: 320,
  heightIn: 24, // STARTING CONFIGURATION height, R104 caps it at 30
  perimeterIn: 110, // R104 cap
  weightLb: 125, // R408 cap is 135 with bumpers
  // FUEL handling. These are per-second rates at the mechanism, not MATCH averages: a modern
  // full-width intake sweeps FUEL far faster than the cycle rate, which is set by travel.
  intakeRate: 7.0, // FUEL/s picked up while intaking
  capacity: 30, // FUEL controlled at once (no manual limit on CONTROL)
  shootRate: 5.0, // FUEL/s released while shooting
  shootAccuracy: 0.85, // P(scored) at the reference distance
  refShootDistanceIn: 60,
  accuracyFalloff: 0.0025, // accuracy lost per inch beyond the reference distance
  // TOWER. timeSec is the climb duration once attached; a ROBOT with no climb mechanism leaves
  // l1/l2/l3 false and never climbs, which is the common case on top-tier ROBOTs.
  climb: { l1: true, l2: true, l3: true, timeSec: 8, attachTimeSec: 2.5 },
  // AUTO routine quality
  auto: { fuelRate: 7.0, preloadShots: 8, accuracy: 0.75, climbLevel: 1, jitter: 0.12 },
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
//   Use the 示例 profiles for generic partners, and type your own scouting numbers for anything
//   you intend to act on.
// ---------------------------------------------------------------------------------------------
export const PRESET_PROVENANCE = {
  sourced: '每条参照机型都带来源链接。能从原文直接读到的（1678 全宽 shooter + 爬 L1、1690 炮塔 + 约 13 BPS + 爬 L1、4414 炮塔 + 85 球料仓、5940 4.5 球宽 shooter + 无爬塔、254 无爬塔）按原文填，读不到的才估。',
  params: '数值仍多为估计值：原文给了的（如 4414 的 85+ 球料仓、1690 的 13 BPS）直接采用，其余按同类机型推断，未经队伍确认。',
};

export const SAMPLES = [
  {
    ...DEFAULT_PROFILE(),
    team: 254,
    name: '254 The Cheesy Poofs',
    ref: 'Overload：揭幕帖讨论确认没有爬塔机构；射击机构未公开说明（帖内提到 belt indexer），此处按全宽估',
    source: 'https://www.chiefdelphi.com/t/team-254-presents-overload/516252',
    mechanism: 'dumper',
    driveSpeedIps: 180,
    intakeRate: 12.0,
    capacity: 65,
    shootRate: 10.0,
    shootAccuracy: 0.92,
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
    name: '1678 Citrus Circuits',
    ref: 'Limestone：全宽 shooter（侧板间距 25in，占满车宽），爬 L1，自动最强（当年两个自动奖）',
    source: 'https://www.citruscircuits.org/2026-robot',
    mechanism: 'dumper',
    driveSpeedIps: 175,
    intakeRate: 11.0,
    capacity: 55,
    shootRate: 10.5,
    shootAccuracy: 0.94,
    heightIn: 22.0, // 27x27in SDS MK5n 车架，可走 TRENCH
    weightLb: 130,
    // 原文：“climb to Level 1 with ease”。§6.5.2 对 L1 的要求只是“不再接触地毯或 TOWER BASE”，
    // 本质是一次很小的抬升，所以时间给得短；给长了会让搜索算出“爬塔不如继续打 FUEL”，与事实相反。
    climb: { l1: true, l2: false, l3: false, timeSec: 3, attachTimeSec: 2 },
    auto: { fuelRate: 11.0, preloadShots: 8, accuracy: 0.93, climbLevel: 1, jitter: 0.04 },
    defenseSkill: 0.62,
    defensePower: 0.62,
    reliability: 0.995,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 1690,
    name: '1690 Orbit',
    ref: 'Kepler：炮塔，移动中射击；帖内有人逐帧数出约 13 BPS；走 TRENCH，爬 L1（主动选 L1 不打 L3）',
    source: 'https://www.chiefdelphi.com/t/orbit-1690-2026-robot-reveal-kepler/515277',
    mechanism: 'turret',
    driveSpeedIps: 172,
    intakeRate: 13.0,
    capacity: 45,
    shootRate: 13.0, // 帖内实测 13 BPS
    shootAccuracy: 0.95,
    heightIn: 21.5, // 帖内讨论“为何选 TRENCH 而非 BUMP”
    weightLb: 124,
    climb: { l1: true, l2: false, l3: false, timeSec: 3, attachTimeSec: 2 }, // L1 = 离开地毯即可（§6.5.2）
    auto: { fuelRate: 12.0, preloadShots: 8, accuracy: 0.9, climbLevel: 1, jitter: 0.06 },
    defenseSkill: 0.5,
    defensePower: 0.5,
    reliability: 0.99,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 4414,
    name: '4414 HighTide',
    ref: 'RipCurrent：炮塔（55.7:1，倾斜补偿，可在 BUMP 上被防守时开火）；料仓 85+（TRENCH）/ 100+（BUMP）；无爬塔章节',
    source: 'https://2026.team4414.com/',
    mechanism: 'turret',
    driveSpeedIps: 170,
    intakeRate: 12.0,
    capacity: 85, // 原文：“Extending hopper holds 85+ balls under the trench, 100+ with net over the bump”
    shootRate: 11.0,
    shootAccuracy: 0.93,
    heightIn: 21.5, // 起始构型需在 TRENCH 下
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
    name: '5940 BREAD',
    ref: 'Lemon Puff：4.5 球宽 shooter + 可调 hood（全宽类，非炮塔）；25.5in 宽单滚筒 intake + juicer 扩容；子系统清单里没有爬塔',
    source: 'https://technicalbinder.team5940.org/',
    mechanism: 'dumper',
    driveSpeedIps: 158,
    intakeRate: 11.0,
    capacity: 55,
    shootRate: 9.5,
    shootAccuracy: 0.9,
    heightIn: 23.5, // 原文强调 smooth traversal of the BUMP
    weightLb: 132,
    climb: { l1: false, l2: false, l3: false, timeSec: 0, attachTimeSec: 0 },
    auto: { fuelRate: 8.5, preloadShots: 8, accuracy: 0.86, climbLevel: 0, jitter: 0.08 },
    defenseSkill: 0.86,
    defensePower: 0.88,
    reliability: 0.995,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 118,
    name: '118 Robonauts',
    ref: '没有提供来源，整条参数都是估计值，仅用来凑满一套三台阵容；请当作占位符',
    source: '（无来源）',
    mechanism: 'turret',
    driveSpeedIps: 173,
    intakeRate: 10.5,
    capacity: 40,
    shootRate: 9.0,
    shootAccuracy: 0.91,
    heightIn: 21.5,
    weightLb: 129,
    climb: { l1: true, l2: false, l3: false, timeSec: 3, attachTimeSec: 2 },
    auto: { fuelRate: 9.0, preloadShots: 8, accuracy: 0.89, climbLevel: 1, jitter: 0.06 },
    defenseSkill: 0.62,
    defensePower: 0.66,
    reliability: 0.99,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 101,
    name: '示例·疾风（循环）',
    mechanism: 'turret',
    driveSpeedIps: 175,
    intakeRate: 10.0,
    capacity: 45,
    shootRate: 8.5,
    shootAccuracy: 0.9,
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
    team: 202,
    name: '示例·磐石（防守）',
    mechanism: 'dumper',
    driveSpeedIps: 132,
    intakeRate: 7.0,
    capacity: 32,
    shootRate: 6.0,
    shootAccuracy: 0.78,
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
    team: 303,
    name: '示例·云梯（爬塔）',
    mechanism: 'dumper',
    driveSpeedIps: 126,
    intakeRate: 7.0,
    capacity: 35,
    shootRate: 6.5,
    shootAccuracy: 0.82,
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
    team: 404,
    name: '示例·全能',
    mechanism: 'turret',
    driveSpeedIps: 150,
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
    team: 505,
    name: '示例·新秀（弱队）',
    mechanism: 'dumper',
    driveSpeedIps: 110,
    intakeRate: 4.0,
    capacity: 16,
    shootRate: 4.5,
    shootAccuracy: 0.62,
    heightIn: 26,
    weightLb: 112,
    climb: { l1: true, l2: false, l3: false, timeSec: 6, attachTimeSec: 3 }, // 新队：L1 也慢
    auto: { fuelRate: 3.0, preloadShots: 8, accuracy: 0.5, climbLevel: 0, jitter: 0.25 },
    defenseSkill: 0.25,
    defensePower: 0.3,
    reliability: 0.93,
  },
  {
    ...DEFAULT_PROFILE(),
    team: 606,
    name: '示例·沉稳（中游）',
    mechanism: 'dumper',
    driveSpeedIps: 142,
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
    // FUEL/s a HUB can push back into the NEUTRAL ZONE through its four exits (§5.4). A HUB has to
    // route every FUEL it receives through its scoring mechanism and out again, so its exit path is
    // a finite bottleneck, and FUEL that cannot leave yet stays inside it. This is the calibrated
    // knob, not a free parameter: real 2026 Einstein Finals ALLIANCES averaged 627 points a MATCH
    // (406 / 456 / 518 / 561 / 711 / 712 across F1 M1-M3, event average 627, high 842, from The Blue
    // Alliance), and with only 504 FUEL on the FIELD (§6.3.4) an ALLIANCE can only reach that by
    // recirculating FUEL about once a MATCH. The 0.1 s kinematic engine has no other ceiling on
    // tempo, so without this every ALLIANCE cycles a fountain and roughly doubles the real score.
    // Verified: two elite preset ALLIANCES playing greedy against each other land on 696, and a
    // lower value matches the real average more exactly but drains the FIELD of loose FUEL, which
    // distorts the END GAME. 4.0 keeps both in range.
    hubExitRate: 4.0,
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
