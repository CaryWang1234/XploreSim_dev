// Golden replay: pin what the engine actually produces, so physics drift is caught by a script.
//
// scripts/verify.mjs checks invariants (no FUEL invented, no shot from outside the ALLIANCE ZONE, the
// FEED chain reaches the HUMAN PLAYER). Those are still true after a change that quietly moves every
// score by 30 points, and a change like that has happened here several times this season. This script
// closes that gap the cheap way: it replays a few fixed MATCHes and compares a digest of every recorded
// frame against the one stored in scripts/golden.json. Any change to the kinematics, the FUEL bookkeeping,
// the foul adjudication, the schedule or the policy weights shows up here, and the first checkpoint whose
// digest moved says roughly when.
//
//   node scripts/golden.mjs            # compare, exit 1 on drift
//   node scripts/golden.mjs --record   # rewrite the fixture after an intended change
//
// The fixture is engine-version dependent on purpose: refresh it only when the change was wanted.
import fs from 'node:fs';
import path from 'node:path';
import { simulateMatch } from '../web/js/engine.js';
import { defaultScenario, makeAlliance, SAMPLES } from '../web/js/model.js';
import { greedyPolicy, capOf } from '../web/js/league.js';
import { createAI } from '../web/js/policy.js';
import { DEFAULT_WEIGHTS } from '../web/js/ai.js';
import { emptyPlan } from '../web/js/fastsim.js';

const FIXTURE = path.join(import.meta.dirname, 'golden.json');
const RECORD = process.argv.includes('--record');

// The same trio on both sides: with one roster per side a MATCH measures the ROBOTs as well as the
// engine (see mirror.mjs), and the point here is to measure the engine.
const TRIO = SAMPLES.slice(0, 3);

const CONFIGS = [
  {
    name: 'greedy-mirror',
    note: 'hand-written cycling plan on both sides, no defence, faults on',
    scenario: { seed: 20260110 },
    build: () => ({ redPolicy: greedyPolicy('red'), bluePolicy: greedyPolicy('blue') }),
  },
  {
    name: 'pinned-score-contact',
    note: 'every ROBOT held on SCORE, §7.4.4 hard contact on, so the foul path is in the digest',
    scenario: { seed: 90001, contactFouls: true },
    build: (sc) => {
      const red = makeAlliance(TRIO, 'red');
      const blue = makeAlliance(TRIO, 'blue');
      const plan = emptyPlan();
      const mk = (side, own, opp, rngSeed) =>
        createAI({
          side,
          weights: DEFAULT_WEIGHTS,
          caps: own.map(capOf),
          oppProfiles: opp,
          rngSeed,
          iterations: 60,
          objective: sc.objective,
          event: sc.event,
          towerL1TeleopAllowed: sc.towerL1TeleopAllowed,
          planOverride: { periods: plan.periods, auto: plan.auto, climb: plan.climb },
        });
      return {
        redAlliance: red,
        blueAlliance: blue,
        redPolicy: mk('red', red.robots, blue.robots, (sc.seed >>> 0) + 11),
        bluePolicy: mk('blue', blue.robots, red.robots, (sc.seed >>> 0) + 29),
      };
    },
  },
  {
    name: 'ai-vs-greedy',
    note: 'the shipped search on red, greedy on blue: MCTS, opponent model and the whole intent ladder',
    scenario: { seed: 700001 },
    build: (sc) => {
      const red = makeAlliance(TRIO, 'red');
      const blue = makeAlliance(TRIO, 'blue');
      return {
        redAlliance: red,
        blueAlliance: blue,
        redPolicy: createAI({
          side: 'red',
          weights: DEFAULT_WEIGHTS,
          caps: red.robots.map(capOf),
          oppProfiles: blue.robots,
          rngSeed: (sc.seed >>> 0) + 11,
          iterations: 60,
          objective: sc.objective,
          event: sc.event,
          towerL1TeleopAllowed: sc.towerL1TeleopAllowed,
        }),
        bluePolicy: greedyPolicy('blue'),
      };
    },
  },
  {
    // The same MATCH as `pinned-score-contact` under the stricter of the two readings the Manual gives
    // for TOWER LEVEL 1: §6.5.2 counts it only in AUTO, Table 6-4 prints a TELEOP value of 10. That
    // conflict is kept as a switch rather than silently resolved (see RULE_CONFLICTS), so a build that
    // stopped honouring the switch has to move a digest — this is the case that says so. Same seed, same
    // pinned plans, same contact settings; the only difference is which reading the score is graded with.
    name: 'pinned-score-towerl1-strict',
    note: '§6.5.2 strict: no TOWER points for LEVEL 1 in TELEOP, on the pinned all-SCORE MATCH above',
    scenario: { seed: 90001, contactFouls: true, towerL1TeleopAllowed: false },
    build: (sc) => CONFIGS[1].build(sc),
  },
];

function fnv(h, s) {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// One digest of the whole frame log plus the same digest cut at five checkpoints, so a failure names
// the stretch of the MATCH where the two runs parted. Numbers are hashed through toFixed so the digest
// does not depend on a float's exponent formatting.
const MARKS = [0.1, 0.25, 0.5, 0.75, 1];

function digest(res) {
  const cuts = MARKS.map(() => null);
  let h = 0x811c9dc5;
  const tl = res.timeline || [];
  for (let k = 0; k < tl.length; k++) {
    const f = tl[k];
    h = fnv(h, `${f.t}|${f.p}|${f.hub.red ? 1 : 0}${f.hub.blue ? 1 : 0}|`);
    h = fnv(h, f.r.map((r) => `${r.i}:${r.x.toFixed(1)},${r.y.toFixed(1)},${r.h.toFixed(2)},${r.c},${r.m},${r.k},${r.d}`).join(';'));
    h = fnv(h, `|${f.fuel.map((p) => p.join(',')).join(' ')}|${JSON.stringify(f.hp)}|${JSON.stringify(f.s)}`);
    for (let m = 0; m < MARKS.length; m++) {
      if (cuts[m] === null && k + 1 >= Math.round(MARKS[m] * tl.length)) cuts[m] = h >>> 0;
    }
  }
  const sums = res.robotStats.reduce(
    (a, s) => {
      a[0] += s.fuelScored || 0;
      a[1] += s.fuelCollected || 0;
      a[2] += s.fouls || 0;
      return a;
    },
    [0, 0, 0],
  );
  return {
    full: h >>> 0,
    cuts,
    total: { red: +res.final.red.total.toFixed(1), blue: +res.final.blue.total.toFixed(1) },
    fuel: { red: res.final.red.fuel, blue: res.final.blue.fuel },
    frames: tl.length,
    scored: sums[0],
    collected: sums[1],
    fouls: sums[2],
  };
}

const ran = CONFIGS.map((cfg) => {
  const sc = { ...defaultScenario(), ...cfg.scenario, faultsEnabled: true };
  const extra = cfg.build ? cfg.build(sc) : {};
  const res = simulateMatch({
    redAlliance: extra.redAlliance || makeAlliance(TRIO, 'red'),
    blueAlliance: extra.blueAlliance || makeAlliance(TRIO, 'blue'),
    redPolicy: extra.redPolicy || greedyPolicy('red'),
    bluePolicy: extra.bluePolicy || greedyPolicy('blue'),
    scenario: sc,
    record: true,
  });
  return { name: cfg.name, note: cfg.note, seed: sc.seed, ...digest(res) };
});

if (RECORD) {
  fs.writeFileSync(FIXTURE, `${JSON.stringify({ format: 'xplore-golden-v1', node: process.version, entries: ran }, null, 2)}\n`, 'utf8');
  console.log(`recorded ${ran.length} MATCHes into ${path.basename(FIXTURE)} (node ${process.version})`);
  for (const e of ran) console.log(`  ${e.name.padEnd(22)} ${e.total.red} / ${e.total.blue}  frames ${e.frames}  digest 0x${e.full.toString(16)}`);
  process.exit(0);
}

let stored = null;
try {
  stored = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
} catch (e) {
  console.log(`FAIL no readable ${path.basename(FIXTURE)} — run \`node scripts/golden.mjs --record\` after an intended engine change`);
  process.exit(1);
}
const bad = [];
for (const e of ran) {
  const want = stored.entries.find((x) => x.name === e.name);
  if (!want) {
    bad.push(`${e.name}: not in the fixture`);
    continue;
  }
  if (want.full === e.full) {
    console.log(`  ok  ${e.name.padEnd(22)} ${e.total.red} / ${e.total.blue}`);
    continue;
  }
  const where = want.cuts.findIndex((c, i) => c !== e.cuts[i]);
  const pct = where < 0 ? 'the whistle' : `${Math.round(MARKS[where] * 100)}% of the MATCH`;
  bad.push(
    `${e.name}: digest 0x${e.full.toString(16)} != recorded 0x${want.full.toString(16)} (first checkpoint to move: ${pct})` +
      ` · total ${want.total.red}/${want.total.blue} -> ${e.total.red}/${e.total.blue}` +
      ` · FUEL ${want.fuel.red}/${want.fuel.blue} -> ${e.fuel.red}/${e.fuel.blue}`,
  );
}

if (bad.length) {
  console.log(`\ngolden replay DRIFTED (${stored.node} recorded, ${process.version} running):`);
  for (const b of bad) console.log(`  ${b}`);
  console.log(`\nIf this change was intended, refresh the fixture: node scripts/golden.mjs --record`);
  process.exit(1);
}
console.log(`OK: ${ran.length} recorded MATCHes replay frame-for-frame identical (node ${process.version}).`);
