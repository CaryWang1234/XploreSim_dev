// Offline A/B harness for the AI's strength.
//
// Every claim about "the AI is stronger now" has to answer two questions: against what, and on
// seeds the change was not tuned on. This script runs named arms (a weight vector plus optional
// createAI options) over disjoint seed families and prints one table, so an arm that only wins on
// the family it was evolved on is visible as such.
//
// Usage:
//   node scripts/ab.mjs
//   ARMS=base,noSearch N=24 FAMILIES=90001,700001 ITER=200 node scripts/ab.mjs
//   OPP=greedy MIX=1 node scripts/ab.mjs        # also dump where the AI's frames went

import { DEFAULT_WEIGHTS, cloneWeights } from '../web/js/ai.js';
import { evaluateVsBaseline, headToHead, runOneOpponentMatch } from '../web/js/league.js';
import { emptyPlan, ROLE } from '../web/js/fastsim.js';
import { INTENT } from '../web/js/engine.js';

const N = Number(process.env.N || 24);
const ITER = Number(process.env.ITER || 200);
const OPP = process.env.OPP || 'greedy';
// SEAT=red|blue pins which ALLIANCE the AI plays instead of alternating it match by match. The two
// seats are not mirror images, so the default alternating figure is an average of two different
// questions; this asks one of them.
const SEAT = process.env.SEAT === 'red' || process.env.SEAT === 'blue' ? process.env.SEAT : null;
const FAMILIES = (process.env.FAMILIES || '90001,700001').split(',').map((x) => Number(x.trim()));

// Pinning the macro plan is the only clean way to ablate the search, so the two "what does a
// defender actually buy" arms pin the same all-SCORE plan twice and differ in one cell: slot 0.
const allScorePlan = () => emptyPlan();
const oneDefenderPlan = () => {
  const p = emptyPlan();
  for (const k of ['TRANSITION', 'SHIFT 1', 'SHIFT 2', 'SHIFT 3', 'SHIFT 4']) p.periods[k] = [ROLE.DEFEND, ROLE.SCORE, ROLE.SCORE];
  return p;
};

// An arm is a name -> () => { weights, aiOptions, scenarioOverride }. `planOverride` pins the macro
// plan. `scenarioOverride` retunes the ENGINE, not the AI, so an arm that only moves the physics
// tells you how much the AI depends on that physics — see the PHYS knobs below.
//
// Each physics knob has an "off" value that restores the pre-rewrite behaviour, which is what makes
// an arm an ablation rather than a second tuning guess: physAllOff should land back on the old
// numbers, and each single-off arm names the one that costs the most.
const PHYS = {
  noOpportunityFire: { turretOpportunityMarginIn: 0 },
  // Lets a turret empty its hopper into a HUB that scores 0, which is what the engine did before the
  // gate. The policy never asks for this shot, so it only ever burned the load the ladder was banking.
  darkFire: { turretFireInDarkWindow: true },
  // Restores the single-tick heading snap, where a ROBOT can reverse its spin direction instantly. The
  // ramp is the control for the turn-limit change: a real drivetrain has to build the spin up and bleed
  // it off, so a turn is a trapezoid and costs cycle time.
  turnRampOff: { turnRampOff: true },
  // -1 removes the impulse and leaves only the positional correction, which is the pre-rewrite
  // behaviour; 0 would still be a perfectly inelastic hit.
  noRestitution: { contactRestitution: -1 },
  noFaceGate: { dumperFaceTolDeg: 180 },
  // Restores the model where a ROBOT could slide sideways between a BUMP lane and a TRENCH lane while
  // its centre was still inside the band, and where only an end-to-end crossing of its OWN band was
  // routed through a corridor at all. That is the control for §5.5/§5.6's seam being a structure.
  // Restores the launch that every FUEL aimed at the exact HUB centre, with the drop drawn at
  // resolution instead of flown to: the stream collapses to one line and a miss comes down somewhere
  // else. That is the control for the dispersion, and for the continuity guard in scripts/verify.mjs.
  noShotSpread: { shotSpreadIn: 0 },
  // Restores the hand-back that wrote a processed FUEL at its resting coordinates the tick the HUB
  // released it, instead of putting it out through a base exit and letting it travel there (§5.4). The
  // control for the exit roll, and for the guard that reads the mouths out of the replay.
  noHubExitRoll: { hubExitRoll: 0 },
  // Restores where a launch a DEFENDER stopped used to come to rest: a whole tick past the bumper that
  // took it, which is often inside the HUB's prism, and then expelled out the structure's shortest way —
  // sometimes the far face. Together with noOpeningHeight it is the control for the continuity guard.
  noBlockStop: { blockStopAtBumper: 0 },
  // Restores a ROBOT standing at a HUB taking a shot that was flying over the prism into the opening,
  // which is 72 in above the FIELD (§5.4) and therefore above any bumper on the carpet.
  noOpeningHeight: { blockAboveOpening: 0 },
  // Restores the throw that flies to its aim point and is displaced afterwards. That is the control for
  // sampling the PASS scatter at release, and it prices the one part of the pass the replay could see: a
  // ball that comes down off the line it was drawn on has to be run back for a partner to get.
  latePassScatter: { passScatterAt: 'resolve' },
  // Removes the landing scatter from a PASS altogether: the ball comes down exactly where it was aimed.
  noPassScatter: { passSpreadFrac: 0 },
  noSeamLock: { seamLock: false },
  physAllOff: { turretOpportunityMarginIn: 0, contactRestitution: -1, dumperFaceTolDeg: 180 },
};
const ARMS = {
  base: () => ({ weights: cloneWeights(DEFAULT_WEIGHTS) }),
  noSearch: () => ({ weights: cloneWeights(DEFAULT_WEIGHTS), aiOptions: { planOverride: emptyPlan() } }),
  noDefend: () => ({
    weights: cloneWeights({ ...DEFAULT_WEIGHTS, pressWhenIdleFrac: 1, defendCarryWeight: 0.1, defendThreatWeight: 0.1 }),
  }),
  // darkPrepSec = 0 removes the "come home before our HUB goes live" rung, which is the control for
  // what a carrying ROBOT does with the last seconds of an INACTIVE window.
  noDarkPrep: () => ({ weights: cloneWeights({ ...DEFAULT_WEIGHTS, darkPrepSec: 0 }) }),
  defenseEfficacyZero: () => ({ weights: cloneWeights({ ...DEFAULT_WEIGHTS, defenseEfficacy: 0 }) }),
  defenseEfficacyHigh: () => ({ weights: cloneWeights({ ...DEFAULT_WEIGHTS, defenseEfficacy: 0.6 }) }),
  planAllScore: () => ({ weights: cloneWeights(DEFAULT_WEIGHTS), aiOptions: { planOverride: allScorePlan() } }),
  planDefender: () => ({ weights: cloneWeights(DEFAULT_WEIGHTS), aiOptions: { planOverride: oneDefenderPlan() } }),
  // The greedy baseline's micro posture, expressed in these weights: dump the moment the HUB is
  // active, chase the nearest pile, no stickiness, no own-half bias. If the AI's disadvantage is its
  // FUEL targeting rather than its plan, this is the arm that shows it.
  dumpEarly: () => ({ weights: cloneWeights({ ...DEFAULT_WEIGHTS, dumpThreshold: 0.15, dumpBeforeIdleFrac: 0.1, dumpBeforeIdleSec: 1 }) }),
  nearestFuel: () => ({
    weights: cloneWeights({
      ...DEFAULT_WEIGHTS,
      clusterDensity: 0.4,
      clusterNear: 0.005,
      clusterStickiness: 0.1,
      clusterOwnHalfBias: 0,
      targetRefreshSec: 0.2,
      clusterHubExitPenalty: 1.6,
    }),
  }),
  greedyLike: () => ({
    weights: cloneWeights({
      ...DEFAULT_WEIGHTS,
      dumpThreshold: 0.15,
      dumpBeforeIdleFrac: 0.1,
      dumpBeforeIdleSec: 1,
      clusterDensity: 0.4,
      clusterNear: 0.005,
      clusterStickiness: 0.1,
      clusterOwnHalfBias: 0,
      targetRefreshSec: 0.2,
    }),
  }),
};

const wanted = (process.env.ARMS || 'base,noSearch,noDefend,defenseEfficacyZero')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// EFFS=0,0.15,0.3,0.6 expands to one arm per value, which is how a single model parameter is
// swept: same seeds, same opponent, only that number moves.
for (const v of (process.env.EFFS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  ARMS[`eff${v}`] = () => ({ weights: cloneWeights({ ...DEFAULT_WEIGHTS, defenseEfficacy: Number(v) }) });
  if (!wanted.includes(`eff${v}`)) wanted.push(`eff${v}`);
}

// PHYS=physAllOff,noFaceGate expands to one arm per knob, weights untouched.
for (const k of (process.env.PHYS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const o = PHYS[k];
  if (!o) {
    console.log(`  unknown physics knob "${k}" (have: ${Object.keys(PHYS).join(', ')})`);
    continue;
  }
  ARMS[k] = () => ({ weights: cloneWeights(DEFAULT_WEIGHTS), scenarioOverride: o });
  if (!wanted.includes(k)) wanted.push(k);
}

// MARGINS=0,10,18,40 sweeps how far past its reference distance a turret still takes a shot it did
// not stop for, which is the one physics knob whose right value is a trade rather than a fact.
for (const v of (process.env.MARGINS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const k = `margin${v}`;
  ARMS[k] = () => ({ weights: cloneWeights(DEFAULT_WEIGHTS), scenarioOverride: { turretOpportunityMarginIn: Number(v) } });
  if (!wanted.includes(k)) wanted.push(k);
}

// PREPS=0,4,8 sweeps how early a carrying ROBOT comes home before its own HUB goes live. 0 is the
// control: the rung never fires and the deny/deliver rungs below it decide the whole window.
for (const v of (process.env.PREPS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const k = `prep${v}`;
  ARMS[k] = () => ({ weights: cloneWeights({ ...DEFAULT_WEIGHTS, darkPrepSec: Number(v) }) });
  if (!wanted.includes(k)) wanted.push(k);
}

// DUMPS=0.5,0.75,1 sweeps how full the hopper has to be before the AI commits to a scoring trip.
// dumpEarly (0.15) is already in ARMS and is catastrophic; this asks the other question, because the
// evolved 0.5 was fitted on an engine that has since changed shape.
for (const v of (process.env.DUMPS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const k = `dump${v}`;
  ARMS[k] = () => ({ weights: cloneWeights({ ...DEFAULT_WEIGHTS, dumpThreshold: Number(v) }) });
  if (!wanted.includes(k)) wanted.push(k);
}

// SWEEP=clusterOwnHalfBias:0,0.6,1.0;targetRefreshSec:0.2,1.2 expands to one arm per value of each
// named weight, everything else held at the shipped default. This is how a single evolved number is
// re-checked against the engine it now runs on: same seeds, same opponent, only that cell moves.
for (const part of (process.env.SWEEP || '').split(';').map((s) => s.trim()).filter(Boolean)) {
  const [key, list] = part.split(':');
  const k0 = key && key.trim();
  if (!k0 || !(k0 in DEFAULT_WEIGHTS)) {
    console.log(`  unknown weight "${k0}" in SWEEP (have: ${Object.keys(DEFAULT_WEIGHTS).join(', ')})`);
    continue;
  }
  for (const v of (list || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const k = `${k0}=${v}`;
    ARMS[k] = () => ({ weights: cloneWeights({ ...DEFAULT_WEIGHTS, [k0]: Number(v) }) });
    if (!wanted.includes(k)) wanted.push(k);
  }
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v, d = 1, n = 7) => v.toFixed(d).padStart(n);

console.log(`A/B vs ${OPP} · ${N} MATCHes per seed family, ${FAMILIES.length} families, iterations ${ITER} · seat ${SEAT || 'alternating'}`);
console.log(`${pad('arm', 22)}${pad('family', 9)}${pad('win%', 7)}${pad('AI', 8)}${pad('OPP', 8)}${pad('margin', 8)}${pad('RS', 7)}`);

const pooled = {};
for (const arm of wanted) {
  const make = ARMS[arm];
  if (!make) {
    console.log(`  unknown arm "${arm}" (have: ${Object.keys(ARMS).join(', ')})`);
    continue;
  }
  const agg = { wins: 0, matches: 0, ai: 0, opp: 0, rp: 0 };
  for (const family of FAMILIES) {
    const { weights, aiOptions, scenarioOverride } = make();
    const r = evaluateVsBaseline({ kind: OPP, weights, matches: N, seed: family, iterations: ITER, aiOptions, scenarioOverride, seat: SEAT });
    agg.wins += r.wins + 0.5 * r.ties;
    agg.matches += r.matches;
    agg.ai += r.avgAiScore * r.matches;
    agg.opp += r.avgOppScore * r.matches;
    agg.rp += r.avgRP * r.matches;
    console.log(
      `${pad(arm, 22)}${pad(family, 9)}${num(r.winRate * 100, 1, 6)}${num(r.avgAiScore, 1, 8)}${num(r.avgOppScore, 1, 8)}${num(r.avgAiScore - r.avgOppScore, 1, 8)}${num(r.avgRP, 2, 6)}`,
    );
  }
  pooled[arm] = {
    win: agg.wins / agg.matches,
    ai: agg.ai / agg.matches,
    opp: agg.opp / agg.matches,
    rp: agg.rp / agg.matches,
  };
  const p = pooled[arm];
  console.log(`${pad('  pooled', 22)}${pad('', 9)}${num(p.win * 100, 1, 6)}${num(p.ai, 1, 8)}${num(p.opp, 1, 8)}${num(p.ai - p.opp, 1, 8)}${num(p.rp, 2, 6)}`);
}

if (Object.keys(pooled).length > 1) {
  console.log('\ndelta against the first arm (pooled, n=' + (N * FAMILIES.length) + ' per arm):');
  const first = pooled[wanted[0]];
  for (const arm of Object.keys(pooled)) {
    if (arm === wanted[0]) continue;
    const p = pooled[arm];
    console.log(
      `  ${pad(arm, 22)} win ${((p.win - first.win) * 100).toFixed(1).padStart(5)} pts   score ${(p.ai - first.ai).toFixed(1).padStart(6)}   margin ${(p.ai - p.opp - (first.ai - first.opp)).toFixed(1).padStart(6)}`,
    );
  }
}

// The yardstick: what the same ROBOTs score when the competent hand-written plan plays itself.
const gg = headToHead({ kindA: 'greedy', kindB: 'greedy', matches: N, seed: FAMILIES[0], iterations: ITER });
console.log(`\ngreedy vs greedy (same ROBOTs, family ${FAMILIES[0]}): ${gg.aScore.toFixed(1)} vs ${gg.bScore.toFixed(1)}`);

// Where the AI's ROBOT-frames actually went, and what its ROBOTs produced. A win-rate change with
// no change in this mix is noise; a mode that eats frames on every arm is a place to look.
if (process.env.MIX === '1') {
  console.log('\nwhere the AI spent its ROBOT-frames (one recorded MATCH per arm, family 1):');
  for (const arm of wanted) {
    const make = ARMS[arm];
    if (!make) continue;
    const { weights, aiOptions, scenarioOverride } = make();
    const { res, aiSide } = runOneOpponentMatch({
      kind: OPP,
      weights,
      seed: FAMILIES[0],
      iterations: ITER,
      aiSide: 'red',
      record: true,
      aiOptions,
      scenarioOverride,
    });
    const mix = new Map();
    for (const f of res.timeline || []) {
      for (const rb of f.r) {
        if (rb.a !== aiSide) continue;
        mix.set(rb.m, (mix.get(rb.m) || 0) + 1);
      }
    }
    const total = [...mix.values()].reduce((a, b) => a + b, 0) || 1;
    const order = ['DEFEND', 'PUSH', 'COLLECT', 'PASS', 'STOCKPILE', 'SCORE', 'CLIMB', 'IDLE', 'FEED'];
    const parts = order
      .filter((k) => mix.get(k))
      .map((k) => `${INTENT[k] || k} ${Math.round((100 * mix.get(k)) / total)}%`);
    const rs = res.robotStats.filter((s) => s.alliance === aiSide);
    const scored = rs.reduce((a, s) => a + s.fuelScored, 0);
    const got = rs.reduce((a, s) => a + s.fuelCollected, 0);
    const wasted = rs.reduce((a, s) => a + s.fuelWasted, 0);
    console.log(
      `  ${pad(arm, 22)} score ${num(res.final[aiSide].total, 0, 4)} | collected ${got} scored ${scored} wasted ${wasted} | ${parts.join(' · ')}`,
    );
  }
}
