// What is one DEFEND ROBOT actually worth, in the engine, as a suppression factor on the opponent's
// FUEL? The analytic model represents defence as `factor = 1/(1 + defenseEfficacy * skill)` and the
// shipped `defenseEfficacy` is 0 — the planner is blind to a body standing in a shooting lane, so it
// cannot price the play at all. This measures the factor the model is supposed to be approximating:
// both sides fly PINNED plans (no search), the only thing that changes is how many of blue's slots are
// told to defend during red's active windows, and red's scored FUEL is the readout.
//
// It is deliberately a two-AI MATCH rather than an AI-vs-baseline one: the baseline never defends, and
// the defender must be a real ROBOT flying the real micro DEFEND intent (shadowing, lane occupancy,
// oriented block radius) for the number to mean anything.
//
//   node scripts/defcal.mjs
//   MATCHES=48 SEED=90001 TR=0 node scripts/defcal.mjs
import { createAI } from '../web/js/policy.js';
import { simulateMatch } from '../web/js/engine.js';
import { DEFAULT_WEIGHTS, cloneWeights } from '../web/js/ai.js';
import { ROLE, emptyPlan } from '../web/js/fastsim.js';
import { SAMPLES, makeAlliance, defaultScenario } from '../web/js/model.js';
import { capOf } from '../web/js/league.js';
import { hubActiveTable } from '../web/js/rules.js';

const MATCHES = Number(process.env.MATCHES || 48);
const SEED = Number(process.env.SEED || 90001);
const KS = (process.env.KS || '0,1,2,3').split(',').map(Number);
const trio = process.env.TR === '1' ? SAMPLES.slice(3, 6) : SAMPLES.slice(0, 3);
const AUTO_WINNER = 'red'; // pins which windows are whose, so every arm sees the same schedule

// The periods where a blue defender can do anything: red's HUB is live and blue's is not.
const sched = hubActiveTable(AUTO_WINNER);
const RED_ACTIVE = sched.filter((r) => r.red && !r.blue).map((r) => r.period);

function pinnedPlan(side, k) {
  const plan = emptyPlan();
  plan.auto = { fuelTarget: 1, climbCount: 0 };
  plan.climb = { count: 0, levels: [0, 0, 0], startAt: 1e9 };
  for (const row of sched) {
    const roles = [ROLE.SCORE, ROLE.SCORE, ROLE.SCORE];
    if (side === 'blue' && k > 0 && RED_ACTIVE.includes(row.period)) {
      for (let i = 0; i < Math.min(k, roles.length); i++) roles[i] = ROLE.DEFEND;
    }
    plan.periods[row.period] = roles;
  }
  return plan;
}

function run(k, seed) {
  const sc = { ...defaultScenario(), autoWinner: AUTO_WINNER, seed };
  const red = makeAlliance(trio, 'red');
  const blue = makeAlliance(trio, 'blue');
  const caps = { red: red.robots.map(capOf), blue: blue.robots.map(capOf) };
  const ai = (side, plan) =>
    createAI({
      side,
      weights: cloneWeights(DEFAULT_WEIGHTS),
      caps: caps[side],
      oppProfiles: side === 'red' ? blue.robots : red.robots,
      rngSeed: seed * 31 + (side === 'red' ? 7 : 13),
      iterations: 1,
      planOverride: plan,
    });
  const res = simulateMatch({
    redAlliance: red,
    blueAlliance: blue,
    redPolicy: ai('red', pinnedPlan('red', 0)),
    bluePolicy: ai('blue', pinnedPlan('blue', k)),
    scenario: sc,
  });
  const stats = res.robotStats.filter((r) => r.alliance === 'red');
  return {
    redFuel: res.final.red.fuel,
    redTotal: res.final.red.total,
    blueFuel: res.final.blue.fuel,
    // Launches red lost to a blue body in its lane, and the blocks blue's defenders made. There is no
    // total-launch counter in the engine, so this is reported as a count per MATCH rather than a rate.
    blocked: stats.reduce((s, r) => s + (r.shotsBlocked || 0), 0),
    scored: stats.reduce((s, r) => s + (r.fuelScored || 0), 0),
    blocks: res.robotStats.filter((r) => r.alliance === 'blue').reduce((s, r) => s + (r.blocks || 0), 0),
  };
}

const caps = makeAlliance(trio, 'red').robots.map(capOf);
const skill = Math.max(...caps.map((c) => c.defenseSkill));
const rows = [];
for (const k of KS) {
  let redFuel = 0;
  let blueFuel = 0;
  let blocked = 0;
  let scored = 0;
  let blocks = 0;
  for (let i = 0; i < MATCHES; i++) {
    const r = run(k, (SEED + i * 7919) >>> 0);
    redFuel += r.redFuel;
    blueFuel += r.blueFuel;
    blocked += r.blocked;
    scored += r.scored;
    blocks += r.blocks;
  }
  rows.push({ k, redFuel: redFuel / MATCHES, blueFuel: blueFuel / MATCHES, blocked: blocked / MATCHES, scored: scored / MATCHES, blocks: blocks / MATCHES });
}

const base = rows.find((r) => r.k === 0) || rows[0];
console.log(`${trio.map((p) => p.team).join('/')} on BOTH ALLIANCES · ${MATCHES} MATCHes per arm · red pinned all-SCORE, blue pinned with k defenders in red's windows (${RED_ACTIVE.join(', ')})`);
console.log(`best defenseSkill in the trio ${skill.toFixed(3)}`);
console.log('k  red FUEL  vs k=0  factor  implied defenseEfficacy   blocked MATCH  red scored  blue FUEL');
for (const r of rows) {
  const factor = r.redFuel / base.redFuel;
  const eff = factor > 0 ? (1 / factor - 1) / Math.max(0.05, skill) : 0;
  console.log(
    `${r.k}  ${r.redFuel.toFixed(1)}  ${(r.redFuel - base.redFuel).toFixed(1).padStart(7)}` +
      `   ${factor.toFixed(3)}   ${eff.toFixed(3).padStart(9)}` +
      `   ${r.blocked.toFixed(1).padStart(8)} ${r.scored.toFixed(1).padStart(9)}  ${r.blueFuel.toFixed(1).padStart(9)}`,
  );
}
console.log(`\nblocked = launches red lost to a blue body in its lane (the engine sweeps each tick's flight segment against` +
  ` every opponent); blocks = the same events counted on the defender. This is the geometric event the analytic model` +
  ` has no representation of, which is why defenseEfficacy has been pinned at 0.`);
