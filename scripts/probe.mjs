// Throughput probe. Answers the only question that decides whether a simulated MATCH is worth
// reading: do the scores land in the same range as a real one? Prints the mechanics that set the
// scoring rate (time actually spent intaking, loose FUEL density) alongside the real 2026 Einstein
// Finals scores the engine is calibrated against.

import { simulateMatch, GEO } from '../web/js/engine.js';
import { makeAlliance, SAMPLES, defaultScenario } from '../web/js/model.js';
import { greedyPolicy } from '../web/js/league.js';

const MATCHES = Number(process.env.MATCHES || 6);
const profRed = [SAMPLES[0], SAMPLES[1], SAMPLES[2]];
const profBlue = [SAMPLES[3], SAMPLES[4], SAMPLES[5]];

const agg = { red: 0, blue: 0, redFuel: 0, blueFuel: 0, redAuto: 0, blueAuto: 0 };
let collectTicks = 0;
let intakeTicks = 0;
let scoreFrames = 0;
let idleFrames = 0;
let freeMean = 0;
let freeMin = Infinity;
let freeFrames = 0;

for (let m = 0; m < MATCHES; m++) {
  const sc = { ...defaultScenario(), seed: 90001 + m * 313 };
  const res = simulateMatch({
    redAlliance: makeAlliance(profRed, 'red'),
    blueAlliance: makeAlliance(profBlue, 'blue'),
    redPolicy: greedyPolicy('red'),
    bluePolicy: greedyPolicy('blue'),
    scenario: sc,
    record: true,
  });
  agg.red += res.final.red.total;
  agg.blue += res.final.blue.total;
  agg.redFuel += res.final.red.fuel;
  agg.blueFuel += res.final.blue.fuel;
  agg.redAuto += res.autoFuel.red;
  agg.blueAuto += res.autoFuel.blue;
  for (const rs of res.robotStats) {
    collectTicks += rs.collectTicks;
    intakeTicks += rs.intakeTicks;
  }
  // The recorded frames are 0.5 s apart and sample every 4th FUEL, so multiply by 4 to recover the
  // loose-FUEL count. sampleFuel() only reports FUEL resting on the FIELD (state 0).
  for (const f of res.timeline) {
    let free = 0;
    for (const [x] of f.fuel) {
      free += 1;
    }
    free *= 4;
    freeMean += free;
    freeFrames += 1;
    if (free < freeMin) freeMin = free;
    for (const r of f.r) {
      if (r.m === 'SCORE') scoreFrames += 1;
      if (r.m === 'IDLE') idleFrames += 1;
    }
  }
}

const n = (v) => (v / MATCHES).toFixed(1);
console.log(`greedy vs greedy, ${MATCHES} matches, sourced presets (254/1678/1690 vs 4414/5940/118)`);
console.log(`  RED  total ${n(agg.red)}  (FUEL ${n(agg.redFuel)}, AUTO FUEL ${n(agg.redAuto)})`);
console.log(`  BLUE total ${n(agg.blue)}  (FUEL ${n(agg.blueFuel)}, AUTO FUEL ${n(agg.blueAuto)})`);
console.log(`\nloose FUEL on FIELD: mean ${(freeMean / freeFrames).toFixed(0)}  min ${freeMin}  (504 staged, 24 preloaded)`);
console.log(`intake ticks ${intakeTicks} of ${collectTicks} collect ticks (${((intakeTicks / Math.max(1, collectTicks)) * 100).toFixed(0)}% actually swallowed FUEL)`);
console.log(`robot-frames in SCORE ${scoreFrames} / IDLE ${idleFrames}`);

const activeSec = 20 + 10 + 2 * 25 + 30; // AUTO + TRANSITION + the two own SHIFTs + END GAME
const perAllianceFuel = (agg.redFuel + agg.blueFuel) / 2 / MATCHES;
console.log(`\nFUEL per ALLIANCE ${perAllianceFuel.toFixed(1)} over ${activeSec} s of active HUB = ${(perAllianceFuel / activeSec).toFixed(2)} FUEL/s alliance-wide`);
console.log(`  real 2026 Einstein Finals (TBA 2026cmptx): blue scored 518 over ~110 active HUB s = ~4.7 FUEL/s`);
console.log(`  real alliance totals F1 M1/M2/M3: 456 / 518,  711 / 561,  712 / 406 (event avg 627, high 842)`);
