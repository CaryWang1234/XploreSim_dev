// Headless validation for the REBUILT engine. Runs a naive policy so the checks exercise the
// rules/accounting paths without any AI help. Invariant failures throw; magnitudes are printed
// so the numbers can be compared against the manual's thresholds (Table 6-5).

import { TIME, POINTS, FUEL, FIELD, rpBars } from '../web/js/rules.js';
import { defaultScenario, makeAlliance, makeRobot, SAMPLES, periodAt } from '../web/js/model.js';
import { simulateMatch, INTENT, GEO, CONTACT_UNABLE_SEVERITY, segmentBoxEntry, bandAtX, bandRegionOf, BUMP_TRENCH_SEAM_IN } from '../web/js/engine.js';
import { monteCarlo, matchSeed } from '../web/js/mc.js';
import { DEFAULT_WEIGHTS } from '../web/js/ai.js';
import { readFileSync } from 'node:fs';

// Reference policy for engine validation: a plain greedy state machine with sticky behaviour
// (no dithering) so the engine is exercised, not the policy. Deliberately ignores HUB windows
// beyond "do not waste FUEL", defence, and capacity planning - the AI is expected to beat it.
export function naivePolicy(side) {
  return {
    reset() {},
    onPeriodStart() {},
    decide(rb, obs) {
      const g = GEO[side];
      const period = periodAt(obs.t);
      const inZone = rb.x >= g.allianceZone[0] && rb.x <= g.allianceZone[1];
      if (period === 'END GAME' && !rb.climb.done && rb.derived.maxClimbLevel >= 1) {
        if (rb.carrying === 0 || obs.t > 146) return { mode: INTENT.CLIMB, level: rb.derived.maxClimbLevel };
      }
      const myHubActive = obs.hub[side];
      if (myHubActive && rb.carrying > 0 && (inZone || rb.carrying >= rb.capacity)) {
        return { mode: INTENT.SCORE };
      }
      if (!myHubActive && rb.carrying >= rb.capacity) {
        return { mode: INTENT.STOCKPILE, target: g.shoot };
      }
      let best = null;
      let bestD = Infinity;
      const st = obs.fuel.state;
      for (let i = 0; i < obs.fuel.total; i += 2) {
        if (st[i] !== 0) continue;
        const dx = obs.fuel.x[i] - rb.x;
        const dy = obs.fuel.y[i] - rb.y;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = { x: obs.fuel.x[i], y: obs.fuel.y[i] };
        }
      }
      if (!best) return { mode: INTENT.STOCKPILE, target: g.shoot };
      return { mode: INTENT.COLLECT, target: best };
    },
  };
}

function invariants(res, label) {
  for (const side of ['red', 'blue']) {
    const f = res.final[side];
    const sum = f.fuel + f.towerAuto + f.towerTeleop + f.foulPoints;
    if (sum !== f.total) throw new Error(`${label}: total mismatch for ${side}: ${sum} != ${f.total}`);
    const rp = f.rp;
    const rpSum = rp.energized + rp.supercharged + rp.traversal + rp.result;
    if (rpSum !== rp.total) throw new Error(`${label}: RP mismatch for ${side}`);
    if (f.towerTotal > POINTS.tower.l1Auto * 2 + POINTS.tower.l3Teleop * 3) {
      throw new Error(`${label}: TOWER points above the physical maximum for ${side}: ${f.towerTotal}`);
    }
  }
  if (!res.hubSchedule) throw new Error(`${label}: no HUB schedule produced`);
  const sched = res.hubSchedule.map((r) => r.period);
  const want = ['AUTO', 'TRANSITION', 'SHIFT 1', 'SHIFT 2', 'SHIFT 3', 'SHIFT 4', 'END GAME'];
  if (sched.join('|') !== want.join('|')) throw new Error(`${label}: HUB schedule periods ${sched}`);
  // Table 6-3: the ALLIANCE that scored more FUEL in AUTO must be INACTIVE for SHIFT 1.
  const s1 = res.hubSchedule.find((r) => r.period === 'SHIFT 1');
  if (res.autoWinner === 'red' && s1.red !== false) throw new Error(`${label}: SHIFT 1 must be inactive for the AUTO winner`);
  if (res.autoWinner === 'blue' && s1.blue !== false) throw new Error(`${label}: SHIFT 1 must be inactive for the AUTO winner`);
  if (TIME.autoSec + TIME.transitionSec + TIME.shiftSec * TIME.shiftCount + TIME.endgameSec !== TIME.matchSec) {
    throw new Error('period durations do not sum to 160 s');
  }
}

function run(count, seed) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const sc = { ...defaultScenario(), seed: seed + i * 7919, autoWinner: 'auto' };
    const red = makeAlliance(SAMPLES.slice(0, 3), 'red');
    const blue = makeAlliance(SAMPLES.slice(3, 6), 'blue');
    const res = simulateMatch({
      redAlliance: red,
      blueAlliance: blue,
      redPolicy: naivePolicy('red'),
      bluePolicy: naivePolicy('blue'),
      scenario: sc,
      record: i === 0,
    });
    invariants(res, `match ${i}`);
    if (i === 0) {
      if (!res.timeline || res.timeline.length < 200) throw new Error('timeline not recorded');
      const first = res.timeline[0];
      const last = res.timeline[res.timeline.length - 1];
      if (first.p !== 'AUTO') throw new Error(`first frame period ${first.p}`);
      if (last.p !== 'END GAME') throw new Error(`last frame period ${last.p}`);
    }
    rows.push(res);
  }
  return rows;
}

// §5.3 ROBOT STARTING LINE + G303-D. Every ROBOT starts on the ALLIANCE ZONE side of the line, in the
// lane of the structure it names: a BUMP, the HUB, or a TRENCH. 'auto' must put the three DRIVER
// STATIONS in three different lanes — one of them the HUB — or it is not spreading them over the
// structures the rule lists. The control is an explicit choice: each setting must move that ROBOT into
// the lane it names, so the check proves the setting is wired through, not just that the default works.
function startPlacement(seed, starts) {
  const prof = SAMPLES.slice(0, 3).map((p, i) => (starts ? { ...p, start: starts[i] } : p));
  const res = simulateMatch({
    redAlliance: makeAlliance(prof, 'red'),
    blueAlliance: makeAlliance(prof, 'blue'),
    redPolicy: naivePolicy('red'),
    bluePolicy: naivePolicy('blue'),
    scenario: { ...defaultScenario(), seed, autoWinner: 'auto' },
    record: true,
  });
  const f = res.timeline[0];
  const red = f.r.filter((r) => r.a === 'red').sort((a, b) => a.i - b.i);
  return {
    x: red.map((r) => r.x),
    y: red.map((r) => r.y),
    lanes: GEO.red.startLanes,
    startX: GEO.red.startX,
    zone: GEO.red.allianceZone,
  };
}

function startChecks(seed) {
  const auto = startPlacement(seed, null);
  const g = GEO.red;
  // Inside the ALLIANCE ZONE (the line is its outer edge, so a start is behind it), and clear of the
  // structures that straddle the line, whose nearest face is at hubX - sizeIn/2.
  const hubFace = g.hub.x - FIELD.hub.sizeIn / 2;
  for (const x of auto.x) {
    if (x >= g.allianceZone[1]) throw new Error(`a ROBOT started at x=${x}, outside the ALLIANCE ZONE (line ${g.allianceZone[1]})`);
    if (x > hubFace) throw new Error(`a ROBOT started at x=${x}, inside the HUB/BUMP band (near face ${hubFace})`);
  }
  const near = (y, lane) => lane.some((v) => Math.abs(y - v) <= 12);
  const laneOf = (y) => {
    if (near(y, g.startLanes.hub)) return 'hub';
    if (near(y, g.startLanes.bump)) return 'bump';
    if (near(y, g.startLanes.trench)) return 'trench';
    return 'none';
  };
  const lanes = auto.y.map(laneOf);
  if (lanes.includes('none')) throw new Error(`auto start does not line up with a lane: y ${auto.y.join(', ')}`);
  if (!lanes.includes('hub')) throw new Error(`auto left the HUB lane empty: ${lanes.join(', ')}`);
  // The two BUMP lanes are the same kind at different y, so what must hold is that no two ROBOTs
  // share a spot: the three starts are pairwise at least 28 in apart, which is what the engine keeps
  // between ROBOTs once the MATCH is running.
  for (let i = 0; i < auto.y.length; i++) {
    for (let j = i + 1; j < auto.y.length; j++) {
      if (Math.abs(auto.y[i] - auto.y[j]) < 28) {
        throw new Error(`auto started two ROBOTs on one spot: y ${auto.y[i]} and ${auto.y[j]}`);
      }
    }
  }
  if (new Set(auto.y).size !== 3) throw new Error(`auto reused a start spot: y ${auto.y.join(', ')}`);
  // The control: force each ROBOT into a named lane and check it went there.
  const forced = startPlacement(seed, ['trench', 'hub', 'trench']);
  const forcedLanes = forced.y.map(laneOf);
  if (forcedLanes[0] !== 'trench' || forcedLanes[1] !== 'hub' || forcedLanes[2] !== 'trench') {
    throw new Error(`an explicit starting position did not take: asked trench/hub/trench, got ${forcedLanes.join(', ')}`);
  }
  if (forced.y[0] === forced.y[2]) throw new Error('two ROBOTs in the same lane started on the same spot');
  console.log('--- §5.3 ROBOT STARTING LINE (opening frame, red) ---');
  console.log(`  auto    x ${auto.x.join(', ')}  lanes ${lanes.join(', ')}  (line at ${g.allianceZone[1]}, start x ${g.startX}, lanes ${JSON.stringify(g.startLanes)})`);
  console.log(`  forced  lanes ${forcedLanes.join(', ')}  y ${forced.y.join(', ')}`);
}

function summarize(rows) {
  const avg = (f) => rows.reduce((a, r) => a + f(r), 0) / rows.length;  const redWins = rows.filter((r) => r.winner === 'red').length;
  const rpDist = [0, 0, 0, 0, 0, 0, 0];
  for (const r of rows) { rpDist[r.final.red.rp.total]++; rpDist[r.final.blue.rp.total]++; }
  console.log('--- summary over', rows.length, 'matches (naive policy both sides) ---');
  console.log('avg total points   red', avg((r) => r.final.red.total).toFixed(1), ' blue', avg((r) => r.final.blue.total).toFixed(1));
  console.log('avg FUEL scored    red', avg((r) => r.final.red.fuel).toFixed(1), ' blue', avg((r) => r.final.blue.fuel).toFixed(1));
  console.log('avg TOWER points   red', avg((r) => r.final.red.towerTotal).toFixed(1), ' blue', avg((r) => r.final.blue.towerTotal).toFixed(1));
  console.log('avg foul pts given red', avg((r) => r.final.blue.foulPoints).toFixed(1), ' blue', avg((r) => r.final.red.foulPoints).toFixed(1));
  console.log('avg AUTO FUEL      red', avg((r) => r.autoFuel.red).toFixed(1), ' blue', avg((r) => r.autoFuel.blue).toFixed(1));
  console.log('red win rate', (redWins / rows.length * 100).toFixed(0) + '%');
  console.log('RP histogram (0..6):', rpDist.join(' '));
  console.log('ENERGIZED RP (>=100 FUEL) rate', (rows.filter((r) => r.final.red.rp.energized).length / rows.length * 100).toFixed(0) + '%');
  console.log('SUPERCHARGED RP (>=360 FUEL) rate', (rows.filter((r) => r.final.red.rp.supercharged).length / rows.length * 100).toFixed(0) + '%');
  console.log('TRAVERSAL RP (>=50 TOWER) rate', (rows.filter((r) => r.final.red.rp.traversal).length / rows.length * 100).toFixed(0) + '%');
  const fouls = new Map();
  const climbs = new Map();
  for (const r of rows) {
    for (const e of r.events) {
      if (e.kind === 'foul') {
        const k = `${e.reason} (${e.points} pts)`;
        fouls.set(k, (fouls.get(k) || 0) + 1);
      }
      if (e.kind === 'climb') {
        const k = `L${e.level} in ${e.period}`;
        climbs.set(k, (climbs.get(k) || 0) + 1);
      }
    }
  }
  console.log('foul reasons:', [...fouls.entries()].map(([k, v]) => `${k} x${v}`).join(' | ') || 'none');
  console.log('climb outcomes:', [...climbs.entries()].map(([k, v]) => `${k} x${v}`).join(' | ') || 'none');
  const st = rows[0].robotStats;
  console.log('--- sample match robot stats ---');
  for (const r of st) {
    console.log(
      `  ${r.alliance} #${r.team} ${r.name}: scored ${r.fuelScored}, wasted ${r.fuelWasted}, collected ${r.fuelCollected}, climb L${r.climbLevel}, pins ${r.pins}, fouls ${r.fouls} (${r.foulPointsGiven} pts), dist ${r.distanceIn}in, active ${r.activeSec.toFixed(0)}s`,
    );
  }
}

// The HUMAN PLAYER is a second actor with its own rules, and the naive policy above deliberately has
// no opinion about it, so it gets its own checks. Each mode is run as a forced command through the
// same `human` hook a policy uses, which is what makes the three comparable: if the engine dropped
// the hook, all three would collapse onto the same match and the separation check below would fail.
function humanRun(mode, seed, accuracy) {
  const mk = (side) => {
    const p = naivePolicy(side);
    p.human = () => mode;
    return p;
  };
  const sc = { ...defaultScenario(), seed, autoWinner: 'auto' };
  if (accuracy !== undefined) sc.humanAccuracy = { red: accuracy, blue: accuracy };
  const prof = SAMPLES.slice(0, 3);
  const res = simulateMatch({
    redAlliance: makeAlliance(prof, 'red'),
    blueAlliance: makeAlliance(prof, 'blue'),
    redPolicy: mk('red'),
    bluePolicy: mk('blue'),
    scenario: sc,
    record: true,
  });
  const last = res.timeline[res.timeline.length - 1].hp;
  let doorOpen = 0;
  let maxHand = 0;
  let offField = 0;
  let robotOut = 0;
  for (const f of res.timeline) {
    for (const side of ['red', 'blue']) {
      if (f.hp[side].d) doorOpen += 1;
      if (f.hp[side].h > maxHand) maxHand = f.hp[side].h;
    }
    for (const [, x, y, kind] of f.fuel) {
      // A resting SCORING ELEMENT must be on the FIELD (G405). One in flight may not be: an HP throw
      // starts in the OUTPOST, behind the ALLIANCE WALL.
      if (kind === 4) continue;
      if (x < 0 || x > FIELD.lengthIn || y < 0 || y > FIELD.widthIn) offField += 1;
    }
    for (const r of f.r) {
      // Including in AUTO and while being shoved: the ALLIANCE WALL is what keeps every ROBOT out of
      // the OUTPOST, and the HUMAN PLAYER works there (G421).
      if (r.x < 5.9 || r.x > FIELD.lengthIn - 5.9 || r.y < 5.9 || r.y > FIELD.widthIn - 5.9) robotOut += 1;
    }
  }
  return { res, red: last.red, blue: last.blue, doorOpen, maxHand, offField, robotOut, fuel: (res.final.red.fuel + res.final.blue.fuel) / 2 };
}

function humanChecks(seed) {
  const hold = humanRun('HOLD', seed);
  const score = humanRun('SCORE', seed);
  const dump = humanRun('DUMP', seed);
  for (const [label, r] of [['HOLD', hold], ['SCORE', score], ['DUMP', dump]]) {
    if (r.offField > 0) throw new Error(`human/${label}: ${r.offField} resting FUEL outside the FIELD (G405)`);
    if (r.robotOut > 0) throw new Error(`human/${label}: ${r.robotOut} ROBOT frames outside the FIELD, so a ROBOT reached the OUTPOST (G421)`);
    if (r.maxHand > 2) throw new Error(`human/${label}: HP held ${r.maxHand} FUEL off the FIELD (G427 caps it at 2)`);
  }
  // The hand has to actually fill, or the cap above is a check on nothing. Only SCORE fills it: an
  // HP with nothing to throw at has no reason to reach into the CHUTE (so DUMP legitimately stays 0).
  if (score.maxHand !== 2) throw new Error(`the HP never filled its hand (max ${score.maxHand}), so the G427 cap was never exercised`);
  // SCORE throws and never opens the door; DUMP opens the door and never throws; HOLD does neither.
  if (score.red.x <= 0 || score.doorOpen !== 0) throw new Error(`SCORE must throw with the CHUTE DOOR shut, got ${score.red.x} throws and ${score.doorOpen} open frames`);
  if (dump.red.x !== 0 || dump.doorOpen <= 0) throw new Error(`DUMP must open the door and not throw, got ${dump.red.x} throws and ${dump.doorOpen} open frames`);
  if (hold.red.x !== 0 || hold.doorOpen !== 0) throw new Error(`HOLD must do nothing, got ${hold.red.x} throws and ${hold.doorOpen} open frames`);
  // Separation between the modes is the control: identical results would mean the hook was ignored.
  // Compared per side rather than on the two-side mean, because the mean of a single MATCH is coarse
  // enough that two genuinely different MATCHes can land on it (seed 20260110 did: SCORE 591/662 and
  // DUMP 590/663, both averaging 626.5) and that coincidence is not a dropped hook.
  const sep = (r) => `${r.res.final.red.fuel}/${r.res.final.blue.fuel}`;
  if (sep(score) === sep(hold) || sep(dump) === sep(hold) || sep(score) === sep(dump)) {
    throw new Error(`the three HP modes did not separate: HOLD ${sep(hold)}, SCORE ${sep(score)}, DUMP ${sep(dump)}`);
  }
  // The throw is a scoring attempt, so the count of throws that went in has to follow the scenario's
  // accuracy within binomial noise. This is the one place the accuracy setting is observable, so it
  // is the check that the setting actually reaches the flight.
  const acc = defaultScenario().humanAccuracy.red;
  const hit = score.red.s;
  const sd = Math.sqrt(Math.max(1, score.red.x) * acc * (1 - acc));
  if (Math.abs(hit - score.red.x * acc) > 4 + 3 * sd) {
    throw new Error(`SCORE put ${hit} of ${score.red.x} throws in, which is not the ${acc} accuracy the scenario set`);
  }
  // ...and a changing accuracy has to move it, or the check above is reading a constant.
  const worse = humanRun('SCORE', seed, 0.35);
  if (worse.red.s >= hit) throw new Error(`accuracy 0.35 put in ${worse.red.s} against ${hit} at 0.75, so the setting is not reaching the throw`);
  console.log('--- HUMAN PLAYER (forced mode, one match each) ---');
  console.log(`  HOLD  throws ${hold.red.x}  door-open frames ${hold.doorOpen}  FUEL/alliance ${hold.fuel.toFixed(0)}`);
  console.log(`  SCORE throws ${score.red.x}  scored ${score.red.s} (${acc * 100}% set)  door-open frames ${score.doorOpen}  FUEL/alliance ${score.fuel.toFixed(0)}`);
  console.log(`  DUMP  throws ${dump.red.x}  door-open frames ${dump.doorOpen}  FUEL/alliance ${dump.fuel.toFixed(0)}`);
  console.log(`  max FUEL in hand ${score.maxHand} (G427 cap 2) | resting FUEL off-FIELD 0 | ROBOT frames outside the walls 0`);
}

// The delivery chain (§5.9.2: "ROBOTS can deliver FUEL to their HUMAN PLAYERS"). A full ROBOT that
// cannot score drives to the CORRAL mouth and pushes its load in for the HUMAN PLAYER to throw. Each
// run forces one ROBOT per ALLIANCE to FEED once it is full, and the HUMAN PLAYER to a fixed mode, so
// the only difference between a run and its control is whether the push happens at all.
function feedRun({ useFeed, humanMode, seed }) {
  const mk = (side) => ({
    reset() {},
    onPeriodStart() {},
    decide(rb, obs) {
      // Half a hopper, not a full one: the load at which a real ROBOT gives up on scoring and goes to the
      // OUTPOST is a policy choice, and a full 45-65 FUEL hopper may never fill in a fuel-thin MATCH. The
      // question this asks is "does delivered FUEL reach the HUMAN PLAYER", so it must not depend on how
      // fast the intake sweeps, which is what a rear intake changes.
      if (useFeed && rb.slot === 0 && rb.carrying >= rb.capacity * 0.5) return { mode: INTENT.FEED };
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < obs.fuel.total; i += 2) {
        if (obs.fuel.state[i] !== 0) continue;
        const d = (obs.fuel.x[i] - rb.x) ** 2 + (obs.fuel.y[i] - rb.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x: obs.fuel.x[i], y: obs.fuel.y[i] };
        }
      }
      return best ? { mode: INTENT.COLLECT, target: best } : { mode: INTENT.STOCKPILE, target: GEO[side].shoot };
    },
    human: () => humanMode,
  });
  const prof = SAMPLES.slice(0, 3);
  const res = simulateMatch({
    redAlliance: makeAlliance(prof, 'red'),
    blueAlliance: makeAlliance(prof, 'blue'),
    redPolicy: mk('red'),
    bluePolicy: mk('blue'),
    scenario: { ...defaultScenario(), seed, autoWinner: 'auto' },
    record: true,
  });
  const delivered = res.robotStats.filter((r) => r.alliance === 'red').reduce((a, r) => a + r.fuelDelivered, 0);
  const pushedIn = res.robotStats.filter((r) => r.alliance === 'red').reduce((a, r) => a + r.fuelPushedIn, 0);
  const hp = res.timeline[res.timeline.length - 1].hp.red;
  return { res, delivered, pushedIn, corral: res.final.red.corral, chute: res.final.red.chute, hpThrows: hp.x, hpHits: hp.s };
}

function feedChecks(seed) {
  const hold = feedRun({ useFeed: true, humanMode: 'HOLD', seed });
  const noHold = feedRun({ useFeed: false, humanMode: 'HOLD', seed });
  const score = feedRun({ useFeed: true, humanMode: 'SCORE', seed });
  const noScore = feedRun({ useFeed: false, humanMode: 'SCORE', seed });
  // `fuelDelivered` counts two mechanisms: a ROBOT emptying its hopper at the CORRAL mouth (the FEED
  // action) and a ROBOT shoving a LOOSE FUEL through that same mouth while driving past it. The second
  // is legal — it is what bulldozing does — and at hubExitRate 4.2 it happened 19 times in one control
  // MATCH, so "nothing may land in the CORRAL without FEED" was never a true statement about the engine.
  // What IS true, and what the control now pins: the mouth deposit needs the FEED intent, and the wall
  // deposit on its own must stay well below it, or this test would be grading the wall.
  const fed = (o) => o.delivered - o.pushedIn;
  if (fed(noHold) !== 0 || fed(noScore) !== 0) {
    throw new Error(`feed control: ${fed(noHold)} + ${fed(noScore)} FUEL deposited at the CORRAL mouth with no FEED plan`);
  }
  // The FEED action has to move a real load, not one ball: the yardstick is the preload a ROBOT can
  // start with (§6.3.4-C, 8 FUEL), because a FEED plan keeps returning to the mouth with what it carried.
  // How much the wall deposited on its own is printed below rather than asserted — it is legal play and
  // its size depends on how loose the FIELD is.
  if (fed(hold) < FUEL.maxPreloadPerRobot) {
    throw new Error(`the FEED plan deposited only ${fed(hold)} FUEL at the CORRAL mouth, under one ROBOT's ${FUEL.maxPreloadPerRobot}-FUEL preload`);
  }
  // The push has to actually move FUEL: a ROBOT that drove to the OUTPOST and deposited nothing would
  // pass every check below by doing nothing.
  if (fed(hold) <= 0 || hold.corral <= 0) {
    throw new Error(`no FUEL reached the CORRAL: fed ${fed(hold)} of ${hold.delivered} delivered, corral ${hold.corral}`);
  }
  // §5.9.2 / G427: the CORRAL is one layer of 36 FUEL, and FUEL pushed with nowhere to go stays with
  // the ROBOT. Delivering at the cap is exactly the boundary, so check the counter never crosses it.
  if (hold.corral > FUEL.corralCapacity) throw new Error(`CORRAL holds ${hold.corral} FUEL, above its ${FUEL.corralCapacity} limit`);
  // The whole point of the play: FUEL a ROBOT cannot score ends up thrown by the HUMAN PLAYER. With
  // the HUMAN PLAYER scoring, the same push makes them throw (delivered FUEL, not the CHUTE, is what
  // is left to throw), and the CORRAL they drew from ends below what was put in.
  if (score.hpThrows <= noScore.hpThrows) {
    throw new Error(`delivered FUEL did not reach the HUMAN PLAYER: ${score.hpThrows} throws with the push against ${noScore.hpThrows} without`);
  }
  if (score.corral >= score.delivered) {
    throw new Error(`CORRAL did not drain: ${score.corral} left of ${score.delivered} delivered, so the HUMAN PLAYER never drew from it`);
  }
  console.log('--- OUTPOST delivery (one ROBOT forced to FEED per ALLIANCE) ---');
  console.log(`  push off, HP HOLD  delivered ${noHold.delivered} (fed ${fed(noHold)} + shoved in ${noHold.pushedIn})  corral ${noHold.corral}`);
  console.log(`  push on,  HP HOLD  delivered ${hold.delivered} (fed ${fed(hold)} + shoved in ${hold.pushedIn})  corral ${hold.corral} (cap ${FUEL.corralCapacity})  chute ${hold.chute}`);
  console.log(`  push on,  HP SCORE delivered ${score.delivered} (fed ${fed(score)})  corral ${score.corral}  HP throws ${score.hpThrows} (hits ${score.hpHits})`);
  console.log(`  push off, HP SCORE delivered ${noScore.delivered} (fed ${fed(noScore)} + shoved in ${noScore.pushedIn})  corral ${noScore.corral}  HP throws ${noScore.hpThrows}`);
}

// §5.4's net. A ROBOT whose BUMPERS are outside its ALLIANCE ZONE may not put a shot into its HUB: the
// HUB sits on the zone line, so the ball would reach the opening from behind and the net would stop it.
// Each side's ROBOTs are forced to fill up and then request SCORE at a fixed aim point — midfield (out
// of zone) for the treatment, inside the zone for the control. The control proves the test is not
// vacuous: if the zone gate (and the net backstop behind it) were both removed the treatment would
// start scoring, and if the aim were simply broken the control would stop scoring.
function netRun({ outOfZone, seed }) {
  const aim = (side) => {
    const z = GEO[side].allianceZone;
    return outOfZone ? { x: (z[0] + z[1]) / 2 + (side === 'red' ? 1 : -1) * 220, y: GEO.yc } : { x: (z[0] + z[1]) / 2, y: GEO.yc };
  };
  const mk = (side) => ({
    reset() {},
    onPeriodStart() {},
    decide(rb, obs) {
      if (rb.carrying >= rb.capacity) return { mode: INTENT.SCORE, target: aim(side) };
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < obs.fuel.total; i += 2) {
        if (obs.fuel.state[i] !== 0) continue;
        const d = (obs.fuel.x[i] - rb.x) ** 2 + (obs.fuel.y[i] - rb.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x: obs.fuel.x[i], y: obs.fuel.y[i] };
        }
      }
      return best ? { mode: INTENT.COLLECT, target: best } : { mode: INTENT.STOCKPILE, target: aim(side) };
    },
    human: () => 'HOLD',
  });
  const prof = SAMPLES.slice(0, 3);
  const res = simulateMatch({
    redAlliance: makeAlliance(prof, 'red'),
    blueAlliance: makeAlliance(prof, 'blue'),
    redPolicy: mk('red'),
    bluePolicy: mk('blue'),
    scenario: { ...defaultScenario(), seed, autoWinner: 'auto' },
    record: false,
  });
  const scored = res.robotStats.reduce((a, r) => a + r.fuelScored, 0);
  const wasted = res.robotStats.reduce((a, r) => a + r.fuelWasted, 0);
  // Launches that left the hopper while the ROBOT was outside its own ALLIANCE ZONE. This is the number
  // the §5.4 rule is actually about: a turret now also fires while it is collecting (its shooter slews
  // independently of the drivetrain), so "scored nothing at all" would fail on legitimate in-zone shots
  // rather than on a ball that got past the net.
  const outOfZoneShots = res.robotStats.reduce((a, r) => a + (r.outOfZoneShots || 0), 0);
  return { scored, wasted, outOfZoneShots };
}

function netChecks(seed) {
  const inZone = netRun({ outOfZone: false, seed });
  const out = netRun({ outOfZone: true, seed });
  if (inZone.scored <= 0) {
    throw new Error(`the shooting control scored nothing (${inZone.scored}), so the net check below is not measuring the zone rule`);
  }
  if (out.outOfZoneShots !== 0) {
    throw new Error(`§5.4 net: ${out.outOfZoneShots} shots were launched from outside the ALLIANCE ZONE`);
  }
  if (out.scored >= inZone.scored) {
    throw new Error(`§5.4 net: aiming outside the ALLIANCE ZONE scored ${out.scored} against the control's ${inZone.scored}, so the gate is not refusing those shots`);
  }
  console.log('--- §5.4 net (ROBOTs full, aiming at their own HUB) ---');
  console.log(`  aimed inside the ALLIANCE ZONE   scored ${inZone.scored}`);
  console.log(`  aimed outside the ALLIANCE ZONE  scored ${out.scored}  wasted ${out.wasted}  launched out of zone ${out.outOfZoneShots}`);
}

// §5.4's net, seen from the PASS side. A throw is a flat, straight flight in this model, so a HUB
// standing in its line stops it at the near face: a policy that aims through the structure cannot put
// a ball through it. The test policy fills up inside its own ALLIANCE ZONE and then throws straight
// down the FIELD at the far wall — and both HUBs sit on that centre line, so EVERY throw in the test
// is aimed through two walls. A flight is a straight line at constant velocity, so the segment from
// where a ball left the ROBOT to where it came down IS its path: if that segment enters no HUB
// footprint, no ball crossed one.
//
// Two controls make that a statement about the net rather than about an empty test. First, each PASS is
// also measured against where it was AIMED: the count of throws whose aim line crossed a HUB must be
// well above zero, or the engine would be refusing a throw nobody attempted. Second, the same MATCH told
// to shoot instead of throw does put FUEL into its own HUB, so the walk is not blind.
const PASS_TEST_FAR = (side) => ({ x: side === 'red' ? GEO.L - 10 : 10, y: GEO.yc });

function passHubWalk(res) {
  // The footprint is shrunk by 2 in because frame positions are stored as integers; a real fly-through
  // is tens of inches inside, so the shrink cannot hide one but does refuse a mere graze of the face.
  const half = FIELD.hub.sizeIn / 2 - 2;
  const edge = FIELD.hub.sizeIn / 2;
  const hubs = [GEO.red.hub, GEO.blue.hub];
  const last = new Map();
  const origin = new Map();
  // The chord from a flight's first frame to wherever its ball next appears is only the path if the ball
  // came down where it was last drawn. It does not always: a throw clipped by a HUB used to be expelled
  // out of the structure's shortest axis, and the chord from the launch to that resting point misses the
  // part of the line that went inside. So every pair of consecutive in-flight frames is tested as well.
  const airborne = new Map();
  let passSeen = 0;
  let shotSeen = 0;
  let passAimedThrough = 0;
  let passCross = 0;
  let passFrameCross = 0;
  let shotCross = 0;
  let restInside = 0;
  for (const f of res.timeline) {
    const now = new Map();
    for (const b of f.fuel) now.set(b[0], b);
    const sideOf = new Map();
    for (const r of f.r) sideOf.set(r.i, r.a);
    for (const [id, b] of now) {
      const p = last.get(id);
      if (b[3] === 4 && (!p || p[3] !== 4)) {
        const pass = b[4] === 3;
        // Element 6 is the launcher's index, which is whose aim line this flight is.
        const side = sideOf.get(b[6]);
        origin.set(id, { x: b[1], y: b[2], pass, aimed: pass && side ? PASS_TEST_FAR(side) : null });
        airborne.set(id, pass ? 0 : -1);
        if (pass) passSeen += 1;
        else shotSeen += 1;
      } else if (b[3] === 4 && airborne.has(id)) {
        if (airborne.get(id) >= 0 && hubs.some((h) => segmentBoxEntry(p[1], p[2], b[1], b[2], h.x, h.y, half) !== null)) {
          airborne.set(id, airborne.get(id) + 1);
        }
      }
      if (p && p[3] === 4 && b[3] !== 4) {
        const o = origin.get(id);
        const frames = airborne.get(id);
        origin.delete(id);
        airborne.delete(id);
        if (!o) continue;
        // The chord covers every drawn segment but the last one — a flight is drawn until it leaves the
        // air, and the piece is then sighted again at wherever it came to rest. A 5.91 in ball standing
        // just clear of a 47 in prism is inside the shrunk footprint's corner, so that final step is the
        // one the chord has to read. (p is the record row: [id, x, y, state, ...], so its position is
        // p[1], p[2] and not the first two elements.)
        const crossed = hubs.some((h) => segmentBoxEntry(o.x, o.y, b[1], b[2], h.x, h.y, half) !== null)
          || hubs.some((h) => segmentBoxEntry(p[1], p[2], b[1], b[2], h.x, h.y, half) !== null);
        if (o.pass) {
          if (o.aimed && hubs.some((h) => segmentBoxEntry(o.x, o.y, o.aimed.x, o.aimed.y, h.x, h.y, half) !== null)) {
            passAimedThrough += 1;
          }
          if (crossed) passCross += 1;
          if (frames > 0) passFrameCross += 1;
          if (hubs.some((h) => Math.abs(b[1] - h.x) <= edge && Math.abs(b[2] - h.y) <= edge)) restInside += 1;
        } else if (crossed) shotCross += 1;
      }
    }
    // The other way a flight ends is by the ball leaving the drawing altogether, which is exactly what a
    // SCORED piece does: the HUB swallows it and state 6 is not recorded. Reading only the transitions
    // that come back onto a drawn ball counts the handful of blocked and net-stopped launches and misses
    // every one of the ~1,000 shots a MATCH that really does reach the HUB — 2 of 1,120 on one seed, 0 on
    // another — so the control arm below was never measuring the detector, it was measuring noise.
    for (const [id, p] of last) {
      if (p[3] !== 4 || now.has(id)) continue;
      const o = origin.get(id);
      const frames = airborne.get(id);
      origin.delete(id);
      airborne.delete(id);
      if (!o) continue;
      const crossed = hubs.some((h) => segmentBoxEntry(o.x, o.y, p[1], p[2], h.x, h.y, half) !== null);
      if (o.pass) {
        if (crossed) passCross += 1;
        if (frames > 0) passFrameCross += 1;
      } else if (crossed) shotCross += 1;
    }
    last.clear();
    for (const [id, b] of now) last.set(id, b);
  }
  return { passSeen, shotSeen, passAimedThrough, passCross, passFrameCross, shotCross, restInside };
}

// A policy that throws as soon as its hands are full, at a fixed far point of the FIELD, and does nothing
// else. The §5.4 PASS walk needs it, and so does the throw half of the continuity walk: the greedy reference
// policy never passes, so a guard written against it reads no throws at all.
function throwingPolicyFactory() {
  const far = PASS_TEST_FAR;
  return (side, shoot) => {
    const zone = GEO[side].allianceZone;
    // The shooting arm has to fire from inside its own ALLIANCE ZONE or G407 refuses the launch, so it
    // picks up the nearest FUEL on its own half and ignores the rest of the FIELD.
    const find = (rb, obs, onlyZone) => {
      let best = null;
      let bestD = Infinity;
      for (let i = 0; i < obs.fuel.total; i += 2) {
        if (obs.fuel.state[i] !== 0) continue;
        if (onlyZone && obs.fuel.x[i] < zone[0] - 20) continue;
        if (onlyZone && obs.fuel.x[i] > zone[1] + 20) continue;
        const d = (obs.fuel.x[i] - rb.x) ** 2 + (obs.fuel.y[i] - rb.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = { x: obs.fuel.x[i], y: obs.fuel.y[i] };
        }
      }
      return best;
    };
    return {
      reset() {},
      onPeriodStart() {},
      decide(rb, obs) {
        if (rb.carrying > 0) {
          return shoot ? { mode: INTENT.SCORE } : { mode: INTENT.PASS, target: far(side) };
        }
        const t = (shoot ? find(rb, obs, true) || find(rb, obs, false) : find(rb, obs, false));
        return t ? { mode: INTENT.COLLECT, target: t } : { mode: INTENT.STOCKPILE, target: GEO[side].shoot };
      },
      human: () => 'HOLD',
    };
  };
}

function passHubRun(seed, shoot) {
  const mk = throwingPolicyFactory();
  const prof = SAMPLES.slice(0, 3);
  return simulateMatch({
    redAlliance: makeAlliance(prof, 'red'),
    blueAlliance: makeAlliance(prof, 'blue'),
    redPolicy: mk('red', shoot),
    bluePolicy: mk('blue', shoot),
    scenario: { ...defaultScenario(), seed, autoWinner: 'auto' },
    record: true,
  });
}

function passHubChecks(seed) {
  const thrown = passHubWalk(passHubRun(seed, false));
  const fired = passHubWalk(passHubRun(seed, true));
  if (thrown.passSeen < 20) {
    throw new Error(`the PASS check only saw ${thrown.passSeen} PASSes thrown, so it is not exercising the throw path`);
  }
  if (thrown.passAimedThrough < 200) {
    throw new Error(`the PASS check aimed only ${thrown.passAimedThrough} of ${thrown.passSeen} throws through a HUB, so its "0 crossings" are mostly throws that never tested the net`);
  }
  if (fired.shotCross <= 0) {
    throw new Error(`the control arm had ${fired.shotSeen} shots and none of them registered as a HUB crossing (${fired.shotCross}), so the detector is blind and the PASS result below means nothing`);
  }
  if (thrown.passCross > 0 || thrown.passFrameCross > 0 || thrown.restInside > 0) {
    throw new Error(`§5.4 net: ${thrown.passCross} of ${thrown.passSeen} PASS chords and ${thrown.passFrameCross} drawn flight paths went into a HUB, and ${thrown.restInside} came to rest inside one`);
  }
  console.log('--- §5.4 net seen from a PASS (aimed straight through both HUBs) ---');
  console.log(`  PASSes thrown ${thrown.passSeen} (${(100 * thrown.passAimedThrough / thrown.passSeen).toFixed(0)}% aimed through a HUB = ${thrown.passAimedThrough})  chord into a HUB ${thrown.passCross}  drawn path into a HUB ${thrown.passFrameCross}  came to rest inside one ${thrown.restInside}`);
  console.log(`  control: ${fired.shotSeen} shots fired at their own HUB, ${fired.shotCross} of them registered as a HUB crossing, so the walk is not blind`);
}

// §5.5/§5.6 from the driving side. A BUMP lane and a TRENCH lane meet at a seam, and that seam is where
// two structures of different heights come together, not a doorway: a ROBOT inside the band stays in the
// lane it entered through. The probe parks every ROBOT inside its own band and then keeps ordering it
// sideways into the OTHER lane, which is the one move the geometry forbids, and walks the recorded frames
// twice: once with the rule shipped, once with sc.seamLock switched off. A crossing is two consecutive
// frames whose centres are both inside the same band with a seam between their y values. The second run is
// the control - if the probe cannot cross with the rule off, it never tested the rule, and "0 crossings"
// above would mean nothing.
function seamProbe(side) {
  const band = GEO[side].band;
  const bump = GEO[side].corridors.find((c) => c.kind === 'bump').y;
  const trench = GEO[side].corridors.find((c) => c.kind === 'trench').y;
  return {
    reset() {},
    onPeriodStart() {},
    decide(rb) {
      const inBand = rb.x >= band[0] && rb.x <= band[1];
      if (!inBand) return { mode: INTENT.COLLECT, target: { x: (band[0] + band[1]) / 2, y: bump } };
      return { mode: INTENT.COLLECT, target: { x: rb.x, y: rb.y < BUMP_TRENCH_SEAM_IN ? bump : trench } };
    },
    human: () => 'HOLD',
  };
}

function seamRun(seed, seamLock) {
  const prof = SAMPLES.slice(0, 3);
  return simulateMatch({
    redAlliance: makeAlliance(prof, 'red'),
    blueAlliance: makeAlliance(prof, 'blue'),
    redPolicy: seamProbe('red'),
    bluePolicy: seamProbe('blue'),
    scenario: { ...defaultScenario(), seed, autoWinner: 'auto', seamLock },
    record: true,
  });
}

function seamWalk(res) {
  // Frame positions are quantised, a ROBOT pinned against the seam jitters by a fraction of an inch, and
  // a centre sitting exactly on the band's edge can round to either side of it. A crossing therefore has
  // to be a move with real margin: both centres at least MARGIN in inside the SAME band, and the two y
  // values at least MARGIN in past the seam. A genuine sideways lane change is 30 in of margin in both,
  // so this cannot hide one - and the control run below is what proves that.
  const margin = 2;
  const prev = new Map();
  let attempts = 0;
  let crossings = 0;
  for (const f of res.timeline) {
    for (const r of f.r) {
      if (r.d) continue;
      const side = bandAtX(r.x);
      if (side && bandRegionOf(r.y) !== (r.y < BUMP_TRENCH_SEAM_IN ? 1 : 0)) attempts += 1;
      const p = prev.get(r.i);
      prev.set(r.i, r);
      if (!p) continue;
      const ps = bandAtX(p.x);
      if (!ps || bandAtX(r.x) !== ps) continue;
      const band = GEO[ps].band;
      if (p.x < band[0] + margin || p.x > band[1] - margin) continue;
      if (r.x < band[0] + margin || r.x > band[1] - margin) continue;
      const lo = Math.min(p.y, r.y);
      const hi = Math.max(p.y, r.y);
      if ([BUMP_TRENCH_SEAM_IN, GEO.W - BUMP_TRENCH_SEAM_IN].some((s) => lo < s - margin && hi > s + margin)) crossings += 1;
    }
  }
  return { attempts, crossings };
}

function seamChecks(seed) {
  const locked = seamWalk(seamRun(seed, true));
  const open = seamWalk(seamRun(seed, false));
  if (locked.attempts < 200) {
    throw new Error(`the seam probe only ordered ${locked.attempts} in-band lane changes, so it is not exercising the sideways move`);
  }
  if (open.crossings === 0) {
    throw new Error(`the control run crossed a seam ${open.crossings} times with the rule switched off, so the walk cannot see the move it is checking for`);
  }
  if (locked.crossings > 0) {
    throw new Error(`§5.5/§5.6 seam: ${locked.crossings} of ${locked.attempts} lane orders carried a ROBOT sideways across a BUMP/TRENCH seam`);
  }
  console.log('--- §5.5/§5.6 BUMP/TRENCH seam (ROBOTs ordered sideways from inside the band) ---');
  console.log(`  lane orders issued inside a band ${locked.attempts}  centres carried across the seam ${locked.crossings}`);
  console.log(`  control, rule off: ${open.crossings} crossings on ${open.attempts} orders, so the walk is not blind`);
}

// A landing is allowed to sit outside the HUB footprint, because the net is a plane at the face and
// the HUB body behind it is solid, so the ball is expelled. Anything beyond this margin is a ball
// that travelled over the HUB instead of into it.
const MISS_PAST_LIMIT_IN = 20;
// §5.4: the HUB opening is 41.7 in across the flats of the hexagon and the prism it sits on is 47 in
// square, so a made shot aims within 20.85 in of the centre and a shot that strikes the structure aims
// at 23.5 in or more (33.2 in on a diagonal).
const HUB_OPEN_R_IN = FIELD.hub.openingHexIn / 2;
const HUB_FACE_IN = FIELD.hub.sizeIn / 2;
// How far the reconstructed aim may sit past the geometry it is checked against: every recorded position
// is truncated to whole inches, and the step that carries the last one forward is that same error divided
// by the ticks flown.
const AIM_TOL_IN = 3;

// §5.4 again, from the other side: a shot that misses the opening must not sail through the HUB and
// come to rest beyond its far face. Every shot leaves the muzzle aimed at the HUB centre, so a ball
// last seen in flight near the hub centre that turns up loose well past the hub's midfield edge is a
// ball that crossed the structure untouched. Measured on two greedy mirrors, the closest direct
// flight landing to a post-processing exit; a HUB exit waits out processingSec, so landings are
// picked out by a short gap between the last in-flight frame and the first loose one. The control is
// sc.netMiss = false, the pre-fix drop, which must put balls out past that face or the check is not
// measuring anything.
function missLandingRun(seed, netMiss, spread, extra, walk) {
  const face = { red: GEO.red.hub.x + FIELD.hub.sizeIn / 2, blue: GEO.blue.hub.x - FIELD.hub.sizeIn / 2 };
  let landings = 0;
  let pastFace = 0;
  let worst = -Infinity;
  let oneFrame = 0;
  let passN = 0;
  let passBad = 0;
  let passWorst = 0;
  const jumps = [];
  for (const f of flightWalk(seed, { netMiss, spread, extra, ...(walk || {}) })) {
    // A HUB exit waits out processingSec before the FUEL reappears, so a landing is told from an exit by
    // a short gap between the last in-flight frame and the first loose one.
    if (f.outcome !== 'loose' || f.gap > 6) continue;
    landings += 1;
    // "Past the HUB's far face" is a statement about a launch aimed at a HUB; a PASS is aimed at a
    // teammate, so it joins the continuity walk without joining the net count.
    if (f.tgt === 3) {
      passN += 1;
      const over = f.jump - (1.5 * f.step + 8);
      if (f.n > 1 && over > 0) passBad += 1;
      if (f.n > 1 && over > passWorst) passWorst = over;
    } else {
      const past = f.tgt === 1 ? f.rest[0] - face.red : face.blue - f.rest[0];
      if (past > MISS_PAST_LIMIT_IN) pastFace += 1;
      if (past > worst) worst = past;
    }
    if (f.n > 1) jumps.push({ jump: f.jump, step: f.step });
    else oneFrame += 1;
  }
  return { landings, pastFace, worst, jumps, oneFrame, passN, passBad, passWorst };
}

function missLandingChecks(seed) {
  const sum = (netMiss) => {
    const acc = { landings: 0, pastFace: 0, worst: -Infinity };
    for (const s of [seed, seed + 13]) {
      const r = missLandingRun(s, netMiss);
      acc.landings += r.landings;
      acc.pastFace += r.pastFace;
      if (r.worst > acc.worst) acc.worst = r.worst;
    }
    return acc;
  };
  const on = sum(undefined);
  const off = sum(false);
  if (on.landings < 20) throw new Error(`only ${on.landings} shots came to rest, so the net check has nothing to measure`);
  if (on.pastFace !== 0) throw new Error(`a missed shot came to rest ${on.worst.toFixed(1)} in past the HUB's far face`);
  if (off.pastFace === 0) throw new Error('the net control put nothing past the far face either, so the check is not measuring the net');
  console.log('--- §5.4 net over a missed shot (direct flight landings, in past the HUB face) ---');
  console.log(`  net on   landings ${on.landings}  past the face ${on.pastFace}  worst ${on.worst.toFixed(1)}`);
  console.log(`  net off  landings ${off.landings}  past the face ${off.pastFace}  worst ${off.worst.toFixed(1)}`);
}

// Reads every shot flight back out of the replay of one naive-policy match. For each flight it gives the
// last frame the ball was seen in the air, the point that line was heading for, and what became of it:
// `in` (the ball left the field, because a scored FUEL is inside the HUB and not drawn), or `loose` with
// the place it came to rest. `shotSpreadIn` switches the dispersion off, which restores the
// aimed-at-centre flight and the independently drawn drop. PASS flights (target 3) are left out unless
// `keepPasses` is set, because most of what reads this walk judges a landing against a HUB and a throw
// toward a teammate has no HUB to be judged against.
function flightWalk(seed, opt = {}) {
  const scenario = {
    ...defaultScenario(),
    seed,
    autoWinner: 'auto',
    ...(opt.netMiss === undefined ? {} : { netMiss: opt.netMiss }),
    ...(opt.spread === undefined ? {} : { shotSpreadIn: opt.spread }),
    ...(opt.extra || {}),
  };
  const mkPolicy = opt.throwing ? throwingPolicyFactory() : (side) => naivePolicy(side);
  const res = simulateMatch({
    redAlliance: makeAlliance(SAMPLES.slice(0, 3), 'red'),
    blueAlliance: makeAlliance(SAMPLES.slice(0, 3), 'blue'),
    redPolicy: mkPolicy('red'),
    bluePolicy: mkPolicy('blue'),
    scenario,
    record: true,
  });
  const tickSec = scenario.chunkSec;
  const frames = res.timeline;
  const endT = frames[frames.length - 1].t;
  // Group the in-flight frames into flights: a ball id is recycled all MATCH, so its positions have to be
  // read as consecutive runs. One run gives its points and the frame it left the air in. A flight of a
  // single frame is a launch blocked in its first tick, which is a legitimate early end and has no step
  // to measure against. A full flight is five frames: the engine integrates a 0.55 s launch at 0.1 s and
  // resolves it on the sixth tick, so the fifth drawn frame sits half a step short of the target, and
  // that is the frame the aim point is reconstructed from when the ball has no resting point to read.
  const runs = new Map();
  const done = [];
  frames.forEach((f, k) => {
    const live = new Set();
    for (const b of f.fuel) {
      if (b[3] !== 4) continue;
      live.add(b[0]);
      const r = runs.get(b[0]);
      if (r && r.k === k - 1) {
        r.k = k;
        r.pts.push([b[1], b[2]]);
        r.t = f.t;
        r.tgt = b[4];
        r.tl = b[5];
      } else {
        if (r) done.push(r);
        runs.set(b[0], { k, id: b[0], pts: [[b[1], b[2]]], t: f.t, tgt: b[4], tl: b[5] });
      }
    }
    for (const [id, r] of runs) if (!live.has(id)) { done.push(r); runs.delete(id); }
  });
  const kOfT = new Map();
  frames.forEach((f, k) => kOfT.set(+f.t.toFixed(2), k));
  const out = [];
  for (const r of done) {
    // A ball caught airborne at the buzzer "lands" on its aim point from wherever the clock stopped it,
    // which is a truncation rather than a statement about where a launch goes, so it is not a landing.
    if (r.t >= endT) continue;
    if (r.tgt === 3 && !opt.keepPasses) continue;
    const n = r.pts.length;
    const [x0, y0] = r.pts[0];
    const [xl, yl] = r.pts[n - 1];
    const sx = n > 1 ? (xl - x0) / (n - 1) : 0;
    const sy = n > 1 ? (yl - y0) / (n - 1) : 0;
    const k0 = kOfT.get(+r.t.toFixed(2));
    let outcome = 'in';
    let rest = null;
    let gap = null;
    for (let k = k0 + 1; k <= k0 + 6 && k < frames.length; k++) {
      const b = frames[k].fuel.find((e) => e[0] === r.id);
      if (!b) continue;
      if (b[3] === 4) { outcome = null; break; }
      // The record draws a FUEL only while it is loose or airborne, so a piece that is missing from the
      // frame straight after its flight and turns up loose a few frames later was HELD in between: that
      // second position is wherever a robot put it down, not where the launch came down. Only the frame
      // immediately after the last flight frame can say anything about the landing.
      if (k - k0 > 1) { outcome = null; break; }
      // And a ball that still had fuse to run when the clock stopped came down on the last frame because
      // the MATCH ended, which is the same truncation the `r.t >= endT` filter above refuses, one frame
      // earlier. A PASS carries eleven ticks of it, so a great many throws are affected.
      if (k >= frames.length - 1 && (r.tl || 0) > tickSec * 1.05) { outcome = null; break; }
      outcome = 'loose';
      rest = [b[1], b[2]];
      gap = k - k0;
      break;
    }
    if (!outcome) continue;
    // The recorded fifth element is the flight time still to run at that frame, so the aim is the last
    // drawn position carried forward by exactly that much of the ball's own step. A constant half-step
    // guess is wrong for a HUMAN PLAYER's throw, which has a longer fuse than a ROBOT's launch.
    const left = (r.tl || 0) / tickSec;
    out.push({
      n,
      tgt: r.tgt,
      hub: r.tgt === 1 ? GEO.red.hub : r.tgt === 2 ? GEO.blue.hub : null,
      step: Math.hypot(sx, sy),
      gap,
      outcome,
      rest,
      tl: r.tl || 0,
      // A flight that ran its whole fuse is drawn with at most one tick of it left at its last frame: a
      // ROBOT's 0.55 s launch shows 0.05 there and a HUMAN PLAYER's 0.7 s throw shows 0.1. Anything still
      // holding more than a tick was stopped short by a DEFENDER's bumper or by the buzzer, and neither
      // says where the launch was aimed.
      truncated: (r.tl || 0) > tickSec * 1.05,
      jump: rest ? Math.hypot(rest[0] - xl, rest[1] - yl) : null,
      aim: [xl + left * sx, yl + left * sy],
    });
  }
  return out;
}

// A launch now flies AT the point it comes down on. Before this the flight was integrated to the exact
// HUB centre and the drop was drawn independently at resolution, so the replay showed a ball arriving
// at the middle of the structure and turning up loose 50 in away — the miss looked exactly like a made
// shot that teleported. The guard measures that gap against the ball's own one-tick step (the last frame
// before resolution is a step short of the aim point, and placeLoose() may nudge the landing by a ball
// diameter, so the bound is 1.5 steps + 8 in rather than a magic number). The control is
// sc.shotSpreadIn = 0, which restores the aimed-at-centre flight and the independent drop, and must
// break the bound or the measurement is not looking at anything. The second control is sc.blockStopAtBumper
// = 0 with sc.blockAboveOpening = 0, which restores the blocked landing that was left a tick past the
// bumper and expelled out of whichever structure contained it; it has to break the bound too, because a
// fan of 22 in on a free carpet is not the only way a FUEL can end up somewhere the replay did not draw.
// A PASS is now held to the same bound. It used to be left out of the walk, which is how its landing
// scatter — drawn on the leftover between the last integrated position and the aim point, and therefore
// always nothing, since a 1.1 s throw spans eleven whole ticks — survived for as long as it did. Its
// control is sc.passScatterAt = 'resolve', the same size scatter sampled after the flight instead of
// before it, and it must break the bound too.
function dispersionChecks(seed) {
  const run = (spread, extra, walk) => {
    const jumps = [];
    let skipped = 0;
    let passN = 0;
    let passBad = 0;
    let passWorst = 0;
    for (const s of [seed, seed + 29]) {
      const r = missLandingRun(s, undefined, spread, extra, walk);
      jumps.push(...r.jumps);
      skipped += r.oneFrame;
      passN += r.passN;
      passBad += r.passBad;
      if (r.passWorst > passWorst) passWorst = r.passWorst;
    }
    const bound = (r) => r.jump > 1.5 * r.step + 8;
    return { n: jumps.length, bad: jumps.filter(bound).length, worst: Math.max(0, ...jumps.map((r) => r.jump - 1.5 * r.step)), skipped, passN, passBad, passWorst };
  };
  const on = run(undefined);
  const off = run(0);
  // The other control is for the class of landing the fan has nothing to do with: a launch a DEFENDER
  // stopped used to come to rest a whole tick past the bumper that took it — which, when the lane ran at
  // the HUB, is inside the prism, and expelling it from there moved the piece out through the nearest
  // face, sometimes the far one. With both rules off this same walk breaks the bound, so the bound is
  // reading the stop point and not only the spread.
  const blocked = run(undefined, { blockStopAtBumper: 0, blockAboveOpening: 0 });
  // A PASS has its own walk, on a policy that actually throws: the reference policy above shoots at its own
  // HUB and has never passed in its life, which is how the throw came to be left out of this guard by a
  // `tgt === 3` in the reader rather than by anything anyone decided. The control is the earlier order — fly
  // to the aim point, then displace the rest point. Because a 1.1 s throw spans eleven whole ticks, the
  // leftover that older draw was made on was about nothing, which is the other reason nobody noticed: the
  // guard was blind and the bug was silent. Sampled at its promised size after the flight, it has to break
  // the bound. The second throw control takes the scatter out altogether and must not break it, so the
  // bound is shown to be reading the landing and not merely the crowd the ball comes down into.
  const throwWalk = { keepPasses: true, throwing: true };
  const passOn = run(undefined, undefined, throwWalk);
  const passLate = run(undefined, { passScatterAt: 'resolve' }, throwWalk);
  const passNone = run(undefined, { passSpreadFrac: 0 }, throwWalk);
  if (on.n < 20) throw new Error(`only ${on.n} shot landings recorded, so the continuity check has nothing to measure`);
  if (passOn.passN < 20) throw new Error(`only ${passOn.passN} PASS landings recorded, so the continuity check is not reading throws at all`);
  if (on.skipped > on.n) throw new Error(`${on.skipped} of ${on.n + on.skipped} landings were single-frame flights, so the bound is being tested against a minority of them`);
  if (on.bad > 0) throw new Error(`${on.bad} of ${on.n} missed shots came to rest more than a step and a ball width from where the replay last saw them flying (worst ${on.worst.toFixed(1)} in past the bound)`);
  if (passOn.passBad > 0) {
    throw new Error(`${passOn.passBad} of ${passOn.passN} PASSes came to rest more than a step and a ball width from where the replay last saw them flying (worst ${passOn.passWorst.toFixed(1)} in past the bound)`);
  }
  if (off.bad === 0) {
    throw new Error('the no-dispersion control broke the continuity bound zero times, so the walk is not measuring the teleport it is meant to catch');
  }
  if (blocked.bad === 0) {
    throw new Error('the old blocked-flight control broke the continuity bound zero times, so the bound is not reading where a stopped FUEL comes to rest');
  }
  if (passLate.passBad === 0) {
    throw new Error('the late-pass-scatter control broke the continuity bound zero times, so the throw walk is not looking at where a PASS comes down');
  }
  if (passNone.passBad > 0) {
    throw new Error(`the no-scatter throw control put ${passNone.passBad} of ${passNone.passN} PASSes outside the bound, so something other than a landing is drawing a throw off its line`);
  }
  console.log('--- a launch lands where it was drawn going (last flight frame to rest, bound 1.5 steps + 8 in) ---');
  console.log(`  dispersion on  landings ${on.n} (plus ${on.skipped} blocked in their first tick)  outside the bound ${on.bad}  worst overshoot ${on.worst.toFixed(1)} in`);
  console.log(`  PASSes, on a policy that throws: ${passOn.passN} landings, outside the bound ${passOn.passBad}, worst overshoot ${passOn.passWorst.toFixed(1)} in`);
  console.log(`  control, spread 0: outside the bound ${off.bad} of ${off.n} landings, worst ${off.worst.toFixed(1)} in, so the walk is not blind`);
  console.log(`  control, blocked shot left where the tick put it: outside the bound ${blocked.bad} of ${blocked.n} landings, worst ${blocked.worst.toFixed(1)} in`);
  console.log(`  control, throw scatter drawn at resolution: outside the bound ${passLate.passBad} of ${passLate.passN} landings, worst ${passLate.passWorst.toFixed(1)} in past`);
  console.log(`  control, no throw scatter at all: outside the bound ${passNone.passBad} of ${passNone.passN} landings, worst ${passNone.passWorst.toFixed(1)} in`);
}

// A fan has to open in two different places at once: a made shot goes into the 41.7 in opening (§5.4), a
// circle of 20.85 in around the HUB centre, and a miss stops on the structure, which is a 47 in square, so
// its aim is at 23.5 in from the centre or more (33.2 in on a diagonal). Getting both from one clamp is
// what broke: the opening circle is smaller than the square, so pushing every launch out to the face moved
// the made shots onto the rim of the prism too, and a going-in shot was drawn clipping the wall — with the
// side effect that its swept segment ran around the middle of the HUB instead of through it, past a
// defender standing there. The made-shot side is the assertion, and it is exact: a scored ball is inside
// the HUB and not drawn, so the flight line is all there is to read, and it is carried forward by the fuse
// time the record itself says is still to run (exact for a ROBOT's 0.55 s launch and a HUMAN PLAYER's 0.7 s
// throw alike). What is left is the whole-inch truncation of every recorded position and the step estimate
// that divides those positions by the ticks flown, which is AIM_TOL_IN. The miss side is only reported:
// placeLoose() moves a ball that comes down against the structure by up to a FUEL spacing, so its resting
// point is the aim plus that, and no radius floor holds. The second arm calibrates the reconstruction:
// sc.shotSpreadIn = 0 aims every launch at the centre, so the same walk must report made shots at no
// radius at all and nothing stopping on the face. Run the identical walk against a worktree of the build
// before the clamp was limited to misses and every one of its 2209 made shots reads outside the opening,
// median 25.5 in from the centre, which is what this guard is for.
function aimChecks(seed) {
  const walk = (opt) => {
    const acc = { made: [], miss: [], cut: 0 };
    for (const s of [seed, seed + 29]) {
      for (const f of flightWalk(s, opt)) {
        // A flight that ended before its own fuse had run out was stopped by something other than
        // reaching where it was aimed: a DEFENDER's bumper in the lane, or the buzzer. Neither says
        // anything about the aim, so only a flight that ran its full fuse is counted.
        if (f.truncated) {
          acc.cut += 1;
          continue;
        }
        const rad = f.outcome === 'in'
          ? Math.hypot(f.aim[0] - f.hub.x, f.aim[1] - f.hub.y)
          : Math.hypot(f.rest[0] - f.hub.x, f.rest[1] - f.hub.y);
        if (f.outcome === 'in') acc.made.push(rad);
        else if (f.n > 1 && f.jump >= 0.25 * f.step && f.jump <= 1.5 * f.step + 8) acc.miss.push(rad);
      }
    }
    return {
      cut: acc.cut,
      made: acc.made.sort((a, b) => a - b),
      miss: acc.miss.sort((a, b) => a - b),
      madeOutside: acc.made.filter((r) => r > HUB_OPEN_R_IN + AIM_TOL_IN).length,
      worstMade: acc.made.length ? Math.max(0, ...acc.made.map((r) => r - HUB_OPEN_R_IN)) : 0,
      missShort: acc.miss.filter((r) => r < HUB_FACE_IN - AIM_TOL_IN).length,
      closestMiss: acc.miss.length ? Math.min(...acc.miss) : Infinity,
    };
  };
  const on = walk({});
  const centred = walk({ spread: 0 });
  const half = (a) => (a.length ? a[Math.floor(a.length / 2)] : NaN);
  if (on.made.length < 20) throw new Error(`only ${on.made.length} made shots recorded, so the aim check has nothing to measure`);
  if (on.miss.length < 10) throw new Error(`only ${on.miss.length} missed shots recorded, so the aim check cannot see the structure`);
  if (on.madeOutside !== 0) {
    throw new Error(`${on.madeOutside} of ${on.made.length} made shots were aimed outside the 41.7 in opening (worst ${on.worstMade.toFixed(1)} in past its ${HUB_OPEN_R_IN} in circle)`);
  }
  if (on.missShort !== 0) {
    throw new Error(`${on.missShort} of ${on.miss.length} missed shots came to rest inside the HUB footprint (closest ${on.closestMiss.toFixed(1)} in against a ${HUB_FACE_IN} in face)`);
  }
  const centredWorst = centred.made.length ? Math.max(...centred.made) : Infinity;
  if (centredWorst > AIM_TOL_IN) {
    throw new Error(`the aimed-at-centre control reconstructs made shots at up to ${centredWorst.toFixed(1)} in, so the walk is biased and the two numbers above measure the walk, not the engine`);
  }
  console.log('--- a made shot aims into the opening, a miss aims at the structure (in from HUB centre) ---');
  console.log(`  made shots ${on.made.length}  median ${half(on.made).toFixed(1)}  outside the ${HUB_OPEN_R_IN} in opening ${on.madeOutside}  worst ${on.worstMade.toFixed(1)} in past it`);
  console.log(`  misses ${on.miss.length}  median ${half(on.miss).toFixed(1)}  closest ${on.closestMiss.toFixed(1)} against the ${HUB_FACE_IN} in face`);
  console.log(`  ${on.cut} flights left the air with more than a tick of fuse still on them, or were swept up again the frame after they landed, so they say nothing about an aim and are not counted`);
  console.log(`  control, spread 0: ${centred.made.length} made shots at median ${half(centred.made).toFixed(1)} in, worst ${centredWorst.toFixed(1)}, so the walk reads the aim it is given`);
}

// §5.4 read from the HUB's other end: "HUBS have a series of exits at the base of the HUB facing towards
// the NEUTRAL ZONE. FUEL processed through the HUB are distributed into the NEUTRAL ZONE via one of four
// exits". The engine used to hand a processed piece back by writing its resting coordinates in the tick the
// exit queue released it, so the replay showed a ball simply appear a hundred inches from the structure with
// nothing drawn in between — the first thing anyone watching the replay noticed. A return now starts at one
// of the four mouths and rolls out to that same sampled point, which is why the RESTING distribution every
// published figure is anchored on does not move while the transit does, and why the mouth is chosen from the
// piece's index rather than from the random stream (the release still spends exactly the two draws it always
// spent, so a recorded MATCH replays the same).
//
// A return is told from any other way a ball comes back onto the carpet by the gap: a piece blocked by a
// defender or stopped by the net is drawn again the next frame, while a processed one waits out the HUB's
// processing time first. MOUTH_TOL_IN carries the whole-inch truncation of the record (0.5 in) and the slack
// of a quarter-spacing. MAX_ROLL_STEP_IN carries one frame at the fastest release the sampling allows — the
// farthest rest point is about 200 in from a mouth, so v = sqrt(2 * 20 * 200) = 89 in/s, 8.9 in per 0.1 s
// frame, plus the truncation — and it is applied only to a step no ROBOT was within reach of, because a
// ROBOT driving through a rolling piece moves it at its own speed, not the piece's. That exclusion is not
// decoration: measured with the window at 23 in, 19 of the 18,249 steps counted break the bound and the
// worst reads 24.2 in, and every one of them disappears with sc.bulldoze = 0, so those steps are the push,
// not the exit. The window itself is one frame of the fastest shipped ROBOT's travel (180 in/s = 18 in) plus
// its corner reach (19.8 in) and the FUEL's radius, rounded up. The third assertion is the other half of the
// complaint — a piece drawn at a mouth and then never moving — and it counts the returns whose OWN steps add
// up to at least 5 in, because travel measured from first sight to last is what a ROBOT's push fakes. The
// control is sc.hubExitDecel = 0: every release still starts at a mouth, none of them moves, and the count has
// to read zero. The first control is sc.hubExitRoll = 0, the instant hand-back, which must fail the mouth
// test or this walk is blind.
const HUB_EXIT_MOUTHS_IN = [-17.625, -5.875, 5.875, 17.625];
const HUB_EXIT_MOUTH_X_IN = FIELD.hub.sizeIn / 2 + FUEL.diameterIn / 2;
const MOUTH_TOL_IN = 4;
const MAX_ROLL_STEP_IN = 18;
// How close a ROBOT has to be to a piece for a step to count as the ROBOT's doing rather than the roll's.
const ROBOT_TOUCH_IN = 50;

function hubExitRun(seed, opt = {}) {
  const scenario = { ...defaultScenario(), seed, autoWinner: 'auto', ...opt };
  const res = simulateMatch({
    redAlliance: makeAlliance(SAMPLES.slice(0, 3), 'red'),
    blueAlliance: makeAlliance(SAMPLES.slice(0, 3), 'blue'),
    redPolicy: naivePolicy('red'),
    bluePolicy: naivePolicy('blue'),
    scenario,
    record: true,
  });
  const frames = res.timeline;
  const runs = new Map();
  const flights = [];
  frames.forEach((f, k) => {
    const live = new Set();
    for (const b of f.fuel) {
      if (b[3] !== 4) continue;
      live.add(b[0]);
      const r = runs.get(b[0]);
      if (r && r.k === k - 1) {
        r.k = k;
        r.tgt = b[4];
      } else {
        if (r) flights.push(r);
        runs.set(b[0], { k, id: b[0], tgt: b[4] });
      }
    }
    for (const [id, r] of runs) if (!live.has(id)) { flights.push(r); runs.delete(id); }
  });
  const out = [];
  for (const fl of flights) {
    if (fl.tgt === 3) continue;
    const hub = fl.tgt === 1 ? GEO.red.hub : GEO.blue.hub;
    const dir = fl.tgt === 1 ? 1 : -1;
    let first = null;
    for (let k = fl.k + 1; k < frames.length && k <= fl.k + 120; k++) {
      const b = frames[k].fuel.find((e) => e[0] === fl.id);
      if (!b) continue;
      if (b[3] === 4) break; // launched again before it was ever drawn loose
      first = { k, x: b[1], y: b[2] };
      break;
    }
    if (!first || first.k - fl.k <= 6) continue;
    const path = [[first.x, first.y]];
    // A step counts against the roll only while no ROBOT is close enough to have shoved the piece. The
    // roll ends the tick the piece stops, and whatever the FIELD does to it after that is not the exit.
    let touched = 0;
    const steps = [];
    let prev = [first.x, first.y];
    for (let k = first.k + 1; k < frames.length && k <= first.k + 60; k++) {
      const b = frames[k].fuel.find((e) => e[0] === fl.id);
      if (!b || b[3] === 4) break;
      const step = Math.hypot(b[1] - prev[0], b[2] - prev[1]);
      const near = frames[k].r.some((r) => Math.hypot(r.x - b[1], r.y - b[2]) < ROBOT_TOUCH_IN);
      if (near) touched += 1;
      else steps.push(step);
      path.push([b[1], b[2]]);
      prev = [b[1], b[2]];
      if (step === 0) break;
    }
    const mouthOff = Math.min(...HUB_EXIT_MOUTHS_IN.map((m) => Math.abs(first.y - hub.y - m)));
    out.push({
      mouthOff,
      mouthX: (first.x - hub.x) * dir,
      frames: path.length,
      maxStep: steps.length ? Math.max(...steps) : 0,
      clearSteps: steps.length,
      // The roll's own distance: the steps no ROBOT was near, summed. Travel measured from first sight to
      // last would count a ROBOT's push as the exit's work, which is the opposite of what is being proved.
      clearTravel: steps.reduce((s, v) => s + v, 0),
      touched,
      // how far the piece got from where it was first seen, which is the whole content of the complaint
      travel: Math.hypot(path[path.length - 1][0] - path[0][0], path[path.length - 1][1] - path[0][1]),
    });
  }
  return out;
}

function hubExitChecks(seed) {
  const walk = (opt) => {
    const acc = [];
    for (const s of [seed, seed + 29]) acc.push(...hubExitRun(s, opt));
    return {
      n: acc.length,
      offMouth: acc.filter((o) => o.mouthOff > MOUTH_TOL_IN || Math.abs(o.mouthX - HUB_EXIT_MOUTH_X_IN) > MOUTH_TOL_IN),
      closest: acc.length ? Math.max(...acc.map((o) => Math.max(o.mouthOff, Math.abs(o.mouthX - HUB_EXIT_MOUTH_X_IN)))) : 0,
      jumps: acc.filter((o) => o.maxStep > MAX_ROLL_STEP_IN),
      worstJump: acc.length ? Math.max(...acc.map((o) => o.maxStep)) : 0,
      // The third half of the complaint is a piece that is drawn and then never moves. It is read off the
      // roll's own steps, because a piece a ROBOT is standing on says nothing about the exit either way —
      // and in the zero-speed control the mouths are camped, so almost every piece is swept inside two
      // frames. `rolled` counts the returns seen moving under the roll; `sat` the ones the walk could not
      // read. The control is sc.hubExitDecel = 0, which gives every return a mouth and no speed.
      rolled: acc.filter((o) => o.clearTravel >= 5).length,
      sat: acc.filter((o) => o.frames >= 3 && o.clearSteps < 2).length,
      travelled: acc.filter((o) => o.frames >= 3).map((o) => o.travel).sort((a, b) => a - b),
      touched: acc.reduce((s, o) => s + o.touched, 0),
    };
  };
  const on = walk({});
  const off = walk({ hubExitRoll: 0 });
  // The second control is for the parked assertion alone: sc.hubExitDecel = 0 leaves the piece at a mouth
  // with no speed at all, which is the failure the assertion describes. If it does not park, the assertion
  // is reading nothing.
  const stalled = walk({ hubExitDecel: 0 });
  if (on.n < 40) throw new Error(`only ${on.n} HUB returns read out of the replay, so the exit check has nothing to measure`);
  if (on.offMouth.length !== 0) {
    throw new Error(`${on.offMouth.length} of ${on.n} FUEL came back onto the FIELD without starting at one of the four HUB exits (worst ${on.closest.toFixed(1)} in off a mouth)`);
  }
  if (on.jumps.length !== 0) {
    throw new Error(`${on.jumps.length} of ${on.n} returns moved ${on.worstJump.toFixed(1)} in between two drawn frames, past one frame of roll (${MAX_ROLL_STEP_IN} in) — a piece is still being teleported`);
  }
  if (on.rolled * 2 < on.n) {
    throw new Error(`only ${on.rolled} of ${on.n} returns are seen moving under the roll (${on.sat} were sat on from their second frame), so the exit is not moving them`);
  }
  if (off.offMouth.length === 0) {
    throw new Error('the instant hand-back control put every return at a mouth too, so this walk is not measuring the exit');
  }
  if (stalled.rolled !== 0) {
    throw new Error(`the zero-speed control moved ${stalled.rolled} of its ${stalled.n} returns, so what this walk calls the roll is not the roll`);
  }
  const med = (a) => (a.length ? a[Math.floor(a.length / 2)] : NaN);
  console.log('--- §5.4 a FUEL a HUB hands back leaves through a base exit and rolls out ---');
  console.log(`  returns ${on.n}  all start within ${MOUTH_TOL_IN} in of a mouth (worst ${on.closest.toFixed(2)} in off; mouths sit ${(FIELD.hub.sizeIn / 2 + FUEL.diameterIn / 2).toFixed(1)} in from the HUB centre)`);
  console.log(`  ${on.rolled} of them are seen moving under the roll, ${on.sat} were sat on from their second frame; median travel from first sight ${med(on.travelled).toFixed(1)} in, worst own step ${on.worstJump.toFixed(1)} in against the ${MAX_ROLL_STEP_IN} in frame ceiling; ${on.touched} steps were skipped because a ROBOT was within ${ROBOT_TOUCH_IN} in and shoved the piece`);
  console.log(`  control, instant hand-back: ${off.offMouth.length} of ${off.n} returns appear away from a mouth (worst ${off.closest.toFixed(1)} in off), so the walk is not blind`);
  console.log(`  control, zero exit speed: ${stalled.rolled} of ${stalled.n} returns move under the roll, which is what the count above is reading`);
}

// FUEL spacing. §5.10.1 makes FUEL a 5.91 in ball, so two of them cannot sit at one point. The
// opening layout is where the engine used to pile them up (the §6.3.4.1 NEUTRAL ZONE box holds 360
// FUEL in 206 x 72 in, past the density where a uniform scatter jams, so its fallback spot landed
// balls on top of one another). Measured on the opening frame with an IDLE policy - the staging is
// the only thing that has run, and a greedy policy's first sweep would pull balls together on its
// own. The control is the same match with the spacing switched off: if it is not measurably worse,
// the spacing code is not what is holding the field apart.
function stackedPairs(seed, spacing) {
  const mk = () => ({
    reset() {},
    onPeriodStart() {},
    decide() {
      return { mode: INTENT.IDLE };
    },
    human: () => 'HOLD',
  });
  const prof = SAMPLES.slice(0, 3);
  const res = simulateMatch({
    redAlliance: makeAlliance(prof, 'red'),
    blueAlliance: makeAlliance(prof, 'blue'),
    redPolicy: mk(),
    bluePolicy: mk(),
    scenario: { ...defaultScenario(), seed, autoWinner: 'auto', fuelSpacing: spacing },
    record: true,
  });
  const free = res.timeline[0].fuel.filter((b) => b[3] === undefined);
  let closest = Infinity;
  let stacked = 0;
  for (let i = 0; i < free.length; i++) {
    for (let j = i + 1; j < free.length; j++) {
      const gap = Math.hypot(free[i][1] - free[j][1], free[i][2] - free[j][2]);
      if (gap < closest) closest = gap;
      if (gap < 3) stacked += 1;
    }
  }
  return { n: free.length, closest, stacked };
}

function spacingChecks(seed) {
  const on = stackedPairs(seed, undefined);
  const off = stackedPairs(seed, 0);
  // Positions are recorded truncated to whole inches, so a true 5.91 in minimum can read as 5; a
  // pair under 3 in is unambiguous stacking whatever the truncation does.
  if (on.stacked !== 0) throw new Error(`FUEL are stacked: ${on.stacked} pairs under 3 in with spacing on`);
  if (off.stacked === 0) throw new Error('FUEL spacing is not doing anything: the control stacks nothing either');
  if (on.closest <= off.closest) throw new Error(`FUEL spacing is not doing anything: closest pair ${on.closest} on against ${off.closest} off`);
  console.log('--- FUEL spacing (opening frame, all loose FUEL, in) ---');
  console.log(`  spacing on   closest ${on.closest.toFixed(2)}   pairs under 3 in ${on.stacked}`);
  console.log(`  spacing off  closest ${off.closest.toFixed(2)}   pairs under 3 in ${off.stacked}`);
}

// A policy that hunts the nearest opponent with slot 0, so the opponent-interaction rules
// (§7.4.4 G415/G416/G417) are exercised on purpose: two naive ROBOTs only touch each other by
// accident, and never deliberately, which is the case G416 and G417 need.
function ramPolicy(side) {
  const base = naivePolicy(side);
  return {
    reset: base.reset,
    onPeriodStart: base.onPeriodStart,
    decide(rb, obs) {
      if (rb.slot !== 0) return base.decide(rb, obs);
      const opp = obs.robots.filter((r) => r.alliance !== side && !r.disabled);
      if (!opp.length) return base.decide(rb, obs);
      let best = opp[0];
      let bestD = Infinity;
      for (const r of opp) {
        const d = Math.hypot(r.x - rb.x, r.y - rb.y);
        if (d < bestD) {
          bestD = d;
          best = r;
        }
      }
      return { mode: INTENT.DEFEND, targetRobot: best.idx };
    },
  };
}

const CONTACT_CODES = ['G415', 'G416', 'G417'];
const contactCodeOf = (e) => CONTACT_CODES.find((c) => String(e.reason).startsWith(c));

function contactRun(seed, scenario) {
  return simulateMatch({
    redAlliance: makeAlliance(SAMPLES.slice(0, 3), 'red'),
    blueAlliance: makeAlliance(SAMPLES.slice(3, 6), 'blue'),
    redPolicy: ramPolicy('red'),
    bluePolicy: naivePolicy('blue'),
    scenario: { ...defaultScenario(), seed, autoWinner: 'auto', ...scenario },
    record: false,
  });
}

// The forced runs make every contact a candidate that always "broke something", so the rule SELECTION
// is readable. A tip threshold out of reach leaves the deliberate path on G416; a tip threshold of 0
// leaves it on G417, which is exactly the mutually-exclusive choice §7.4.4 asks for.
function contactForced(seed, tip) {
  const res = contactRun(seed, { contactFouls: true, contactHitSeverity: 0, contactImpairP: 1, contactTipSeverity: tip });
  const side = {};
  for (const r of res.robotStats) side[r.idx] = r.alliance;
  const codes = { G415: 0, G416: 0, G417: 0 };
  const cards = { YELLOW: 0, RED: 0 };
  let impaired = 0;
  const fouls = res.events.filter((e) => contactCodeOf(e));
  for (const e of fouls) {
    codes[contactCodeOf(e)] += 1;
    if (e.points !== POINTS.foul.major) throw new Error(`contact foul is not a MAJOR FOUL: ${e.points} points`);
    // `e.against` is the ALLIANCE being charged, so it has to be the rammer's own — the points go to
    // the other side. Charged to the victim instead, the foul would pay the side that committed it.
    if (side[e.robot] !== e.against) throw new Error(`a contact foul was charged to ${e.against} instead of to the rammer's ALLIANCE`);
    if (!/MAJOR FOUL \+ (YELLOW|RED) CARD/.test(e.reason)) throw new Error(`contact foul has no card: ${e.reason}`);
  }
  const seen = {};
  const log = res.events.filter((e) => e.kind === 'contact');
  for (const e of log) {
    if (!CONTACT_CODES.includes(e.code)) throw new Error(`unknown contact code ${e.code}`);
    const expected = e.severity >= CONTACT_UNABLE_SEVERITY || (e.code === 'G417' && (seen[e.rammer] || 0) > 0) ? 'RED' : 'YELLOW';
    if (e.card !== expected) throw new Error(`card wrong at t=${e.t}: ${e.card}, expected ${expected}`);
    cards[e.card] += 1;
    // §7.4.4 mutual exclusivity: one interaction, one rule, one foul. `seen` counts this rammer's
    // earlier contact fouls, which is the CONTINUOUS/REPEATED case the escalation keys on.
    seen[e.rammer] = (seen[e.rammer] || 0) + 1;
    // G415 is only available to a rammer whose BUMPERS were completely outside its ALLIANCE ZONE, so
    // that implication has to hold. G416 has no zone condition ("anywhere on the FIELD") and the engine
    // prefers it for a hit it judges deliberate, so it is checked through the tip/deliberate split
    // below instead. The log rounds x to whole inches, so 1 in of tolerance keeps a contact right on
    // the line from reading as either.
    const ramSide = side[e.rammer];
    const zone = GEO[ramSide].allianceZone;
    const outside = ramSide === 'red' ? e.at - 14 > zone[1] : e.at + 14 < zone[0];
    const onTheLine = ramSide === 'red' ? Math.abs(e.at - 14 - zone[1]) <= 1 : Math.abs(e.at + 14 - zone[0]) <= 1;
    if (e.code === 'G415' && !outside && !onTheLine) throw new Error(`G415 for a contact initiated inside the ALLIANCE ZONE (x ${e.at})`);
  }
  if (log.length !== fouls.length) throw new Error(`contact log ${log.length} does not match the ${fouls.length} fouls assessed`);
  impaired += res.robotStats.reduce((a, r) => a + r.impairedSec, 0);
  return { codes, cards, log: log.length, impaired, fouls: fouls.length };
}

function contactChecks(seed) {
  // Control: the family is off unless it is switched on.
  let offFouls = 0;
  let offImpaired = 0;
  for (const s of [seed, seed + 29]) {
    const res = contactRun(s, {});
    offFouls += res.events.filter((e) => contactCodeOf(e)).length;
    offImpaired += res.robotStats.reduce((a, r) => a + r.impairedSec, 0);
  }
  if (offFouls !== 0) throw new Error(`G415/G416/G417 assessed with the switch off: ${offFouls} fouls`);
  if (offImpaired !== 0) throw new Error(`contact impairment happened with the switch off: ${offImpaired} robot-seconds`);

  const delib = { codes: { G415: 0, G416: 0, G417: 0 }, cards: { YELLOW: 0, RED: 0 }, log: 0, impaired: 0 };
  const tip = { codes: { G415: 0, G416: 0, G417: 0 }, cards: { YELLOW: 0, RED: 0 }, log: 0, impaired: 0 };
  for (const s of [seed, seed + 29]) {
    for (const [acc, tipTh] of [
      [delib, 1e6],
      [tip, 0],
    ]) {
      const r = contactForced(s, tipTh);
      for (const c of CONTACT_CODES) acc.codes[c] += r.codes[c];
      acc.cards.YELLOW += r.cards.YELLOW;
      acc.cards.RED += r.cards.RED;
      acc.log += r.log;
      acc.impaired += r.impaired;
    }
  }
  if (delib.log < 20) throw new Error(`only ${delib.log} contact fouls in the forced run; nothing to measure`);
  if (delib.codes.G415 === 0) throw new Error('no G415 in the forced run');
  if (delib.codes.G416 === 0) throw new Error('no G416 from a deliberate ram');
  if (delib.codes.G417 !== 0) throw new Error(`G417 assessed with the tip threshold out of reach: ${delib.codes.G417}`);
  if (tip.codes.G417 === 0) throw new Error('no G417 from a deliberate tip');
  if (tip.codes.G416 !== 0) throw new Error(`G416 assessed on the same hit as a G417 tip: ${tip.codes.G416}`);
  if (delib.impaired <= 0 || tip.impaired <= 0) throw new Error('a contact foul did not impair anybody');
  console.log('--- §7.4.4 G415/G416/G417 (forced: every contact, always damages) ---');
  console.log(`  switch off   0 fouls, 0 impaired robot-seconds`);
  console.log(`  deliberate ram (tip out of reach)  ${delib.log} fouls  G415 ${delib.codes.G415}  G416 ${delib.codes.G416}  G417 ${delib.codes.G417}  cards YELLOW ${delib.cards.YELLOW} RED ${delib.cards.RED}  impaired ${delib.impaired.toFixed(0)} robot-s`);
  console.log(`  deliberate tip (tip threshold 0)   ${tip.log} fouls  G415 ${tip.codes.G415}  G416 ${tip.codes.G416}  G417 ${tip.codes.G417}  cards YELLOW ${tip.cards.YELLOW} RED ${tip.cards.RED}  impaired ${tip.impaired.toFixed(0)} robot-s`);
}

// ---- Benched ROBOTs (`plays: false`) and the DRIVER level ----
const benched = (profiles, keep) => profiles.map((p, i) => ({ ...p, plays: i < keep }));

function fieldRun(seed, keepRed, keepBlue, driver) {
  const drv = (p) => (driver ? { ...p, driver } : p);
  return simulateMatch({
    redAlliance: makeAlliance(benched(SAMPLES.slice(0, 3), keepRed).map(drv), 'red'),
    blueAlliance: makeAlliance(benched(SAMPLES.slice(3, 6), keepBlue).map(drv), 'blue'),
    redPolicy: naivePolicy('red'),
    bluePolicy: naivePolicy('blue'),
    scenario: { ...defaultScenario(), seed, autoWinner: 'auto' },
    record: true,
  });
}

function fieldChecks(seed) {
  // A 1v1 is one ROBOT a side; the DRIVER STATIONS close up around the bench.
  const duel = fieldRun(seed, 1, 1);
  if (duel.robotStats.length !== 2) throw new Error(`a 1v1 fielded ${duel.robotStats.length} ROBOTs`);
  const f0 = duel.timeline[0];
  if (f0.r.length !== 2) throw new Error(`the opening frame of a 1v1 has ${f0.r.length} ROBOTs`);
  for (const r of f0.r) {
    const z = GEO[r.a].allianceZone;
    if (r.x < z[0] || r.x > z[1]) throw new Error(`a benched-roster ROBOT starts outside its ALLIANCE ZONE (${r.a} x ${r.x})`);
  }
  const looseAt0 = (res) => res.timeline[0].fuel.filter((b) => b[3] === undefined || b[3] === 0).length;
  const full = fieldRun(seed, 3, 3);
  if (full.robotStats.length !== 6) throw new Error(`a full roster fielded ${full.robotStats.length} ROBOTs`);
  // §6.3.4 stages a fixed 504 FUEL, so benching four ROBOTs has to move their preloads back into the
  // NEUTRAL ZONE rather than shrink the FIELD: four ROBOTs benched x 8 preloaded (G303-I) is 32.
  const moved = looseAt0(duel) - looseAt0(full);
  if (moved !== 32) throw new Error(`benching four ROBOTs moved ${moved} loose FUEL, expected 32`);

  // The DRIVER level has to move the three things it claims to, in order, and Average must be a no-op
  // because the rest of the page is measured against it.
  const at = (d) => makeRobot(d ? { driver: d } : {}, 'red', 0);
  const levels = ['rookie', 'average', 'good', 'elite'].map(at);
  for (let i = 1; i < levels.length; i++) {
    if (!(levels[i].shootAccuracy > levels[i - 1].shootAccuracy)) {
      throw new Error(`aim does not improve from ${levels[i - 1].driver} to ${levels[i].driver}`);
    }
    if (!(levels[i].aimFactor < levels[i - 1].aimFactor)) {
      throw new Error(`aim time does not fall from ${levels[i - 1].driver} to ${levels[i].driver}`);
    }
    if (!(levels[i].defenseSkill > levels[i - 1].defenseSkill)) {
      throw new Error(`defence does not rise from ${levels[i - 1].driver} to ${levels[i].driver}`);
    }
  }
  const untouched = at(null);
  if (untouched.shootAccuracy !== levels[1].shootAccuracy || untouched.aimFactor !== 1 || untouched.defenseSkill !== levels[1].defenseSkill) {
    throw new Error('the Average driver is not a no-op');
  }

  console.log('--- benched ROBOTs and the DRIVER level ---');
  console.log(`  1v1 opening frame: ${f0.r.map((r) => `${r.a} x${r.x.toFixed(1)} y${r.y.toFixed(1)}`).join(', ')}  (${duel.robotStats.length} ROBOTs)`);
  console.log(`  staged FUEL at t=0: ${looseAt0(full)} loose with six ROBOTs, ${looseAt0(duel)} with two (${moved} back into the NEUTRAL ZONE, §6.3.4)`);
  console.log(`  drivers: ${levels.map((l) => `${l.driver} aim ${l.shootAccuracy.toFixed(2)} / time x${l.aimFactor} / defence ${l.defenseSkill.toFixed(2)}`).join('  |  ')}`);
}

// The batch ladder: a batch keeps one row per MATCH, names the MATCHes at the ends of its distributions, and
// replays a flagged row by re-running the seed it was measured on. Two things can go wrong and both are silent
// in a browser — a row that points at the wrong MATCH, and a replay that re-rolls instead of reproducing — so
// they are checked here. This also prints what a MATCH costs with the AI seat searching, which is the number the
// page's cap is a statement about.
// #129: the single-MATCH flow ledger — where a ROBOT took its FUEL from, how much of what its own HUB handed
// back it got to keep, and what its seconds and its inches went on. All of it is bookkeeping, so the two
// things worth holding are that the columns close on one another and that the reclaim column measures a real
// mechanism: the control arm shuts the HUB exits, and a HUB that returns nothing has nothing to be reclaimed
// from it.
function flowChecks(seed) {
  const run = (extra) => simulateMatch({
    redAlliance: makeAlliance(SAMPLES.slice(0, 3).map((p) => ({ ...p })), 'red'),
    blueAlliance: makeAlliance(SAMPLES.slice(3, 6).map((p) => ({ ...p })), 'blue'),
    redPolicy: naivePolicy('red'),
    bluePolicy: naivePolicy('blue'),
    scenario: { ...defaultScenario(), seed, autoWinner: 'auto', ...extra },
    record: true,
  });
  const wrong = [];
  const tally = { taken: 0, neutral: 0, zone: 0, feed: 0, kept: 0, back: 0, scored: 0, wasted: 0, scoreSec: 0, feedSec: 0, droveIn: 0 };
  for (const r of [run({}), run({ seed: seed + 977 })]) {
    for (const s of r.robotStats) {
      const cf = s.collectFrom;
      const srcSum = cf.neutral + cf.zone + cf.feed;
      if (srcSum !== s.fuelCollected) wrong.push(`${s.name}: its three sources sum to ${srcSum} but it took ${s.fuelCollected}`);
      const sec = Object.values(s.modeSec).reduce((a, v) => a + v, 0);
      if (Math.abs(sec - s.activeSec) > 0.2) wrong.push(`${s.name}: the mode clock reads ${sec.toFixed(1)} s against ${s.activeSec.toFixed(1)} s live`);
      const inches = Object.values(s.modeIn).reduce((a, v) => a + v, 0);
      if (Math.abs(inches - s.distanceIn) > 1) wrong.push(`${s.name}: the mode inches read ${inches.toFixed(0)} against ${s.distanceIn} in`);
      if (s.fuelReclaimed > s.fuelCollected) wrong.push(`${s.name}: kept ${s.fuelReclaimed} of the ${s.fuelCollected} it took`);
      tally.taken += s.fuelCollected;
      tally.neutral += cf.neutral;
      tally.zone += cf.zone;
      tally.feed += cf.feed;
      tally.kept += s.fuelReclaimed;
      tally.scored += s.fuelScored;
      tally.wasted += s.fuelWasted;
      tally.scoreSec += s.modeSec.SCORE;
      tally.feedSec += s.modeSec.FEED;
      tally.droveIn += s.distanceIn;
    }
    tally.back += r.hubReturned.red + r.hubReturned.blue;
  }
  const shut = run({ hubExitRate: 0 });
  const shutBack = shut.hubReturned.red + shut.hubReturned.blue;
  const shutKept = shut.robotStats.reduce((a, s) => a + s.fuelReclaimed, 0);
  if (shutBack > 0) wrong.push(`a HUB with its exits shut still handed ${shutBack} FUEL back onto the FIELD`);
  if (shutKept > 0) wrong.push(`${shutKept} FUEL was reclaimed from HUBs that returned none`);
  if (tally.feed <= 0) wrong.push('nobody took FUEL at a FEED outlet in either MATCH, so the split cannot tell a feed line from a collector');
  if (tally.kept <= 0) wrong.push('no ALLIANCE kept anything out of its own HUB returns, so the reclaim column measures nothing');
  if (wrong.length) throw new Error(`flow ledger: ${wrong.join('; ')}`);
  console.log('--- single-MATCH flow ledger (where the FUEL came from, and what the windows were worth) ---');
  console.log(`  ${tally.taken} FUEL taken over 2 MATCHes: ${tally.neutral} in the NEUTRAL ZONE, ${tally.zone} in an ALLIANCE ZONE, ${tally.feed} at a FEED outlet · the HUBs handed ${tally.back} back onto the FIELD and the fleets took ${tally.kept} of them (${Math.round((tally.kept / tally.back) * 100)}%)`);
  console.log(`  ${tally.scored} went into an active HUB against ${tally.wasted} into a dark one, so ${Math.round((tally.scored / (tally.scored + tally.wasted)) * 100)}% of what reached a HUB reached a window · ${tally.scoreSec.toFixed(0)} s of SCORE mode and ${tally.feedSec.toFixed(0)} s of FEED mode over ${(tally.droveIn / 12 / 6).toFixed(0)} ft a ROBOT`);
  console.log(`  with the exits shut the HUBs return ${shutBack} and the reclaim column reads ${shutKept}, which is the control: the column moves with the mechanism it names`);
}

function batchLadderChecks(seed) {
  const max = Number(readFileSync(new URL('../web/js/ui.js', import.meta.url), 'utf8').match(/const MAX_BATCH = (\d+)/)?.[1]);
  const common = {
    profilesRed: SAMPLES.slice(0, 3).map((p) => ({ ...p })),
    profilesBlue: SAMPLES.slice(3, 6).map((p) => ({ ...p })),
    weights: DEFAULT_WEIGHTS,
    iterations: 60,
    mode: 'vsBaseline',
    opponentKind: 'greedy',
    aiSide: 'red',
  };
  const t0 = Date.now();
  const r = monteCarlo({ ...common, seed, matches: 5, recordFirst: true });
  const ms = (Date.now() - t0) / r.matches;
  const wrong = [];
  if (r.rows.length !== 5) wrong.push(`the batch returned ${r.rows.length} rows for 5 MATCHes`);
  r.rows.forEach((row, i) => {
    if (row.n !== i + 1) wrong.push(`row ${i} calls itself MATCH ${row.n}`);
    if (row.seed !== matchSeed(seed, i)) wrong.push(`MATCH ${row.n} carries seed ${row.seed}, not ${matchSeed(seed, i)}`);
  });
  for (const [key, at] of Object.entries(r.at)) {
    const row = r.rows[at];
    if (!row) {
      wrong.push(`${key} points outside the batch`);
      continue;
    }
    const value = key.endsWith('Ai') ? row.ai : key.endsWith('Opp') ? row.opp
      : key.endsWith('Margin') ? row.margin : row.ai + row.opp;
    if (key === 'bestTotal' && value !== r.bestTotal) wrong.push(`bestTotal reads ${r.bestTotal} but MATCH ${row.n} scored ${value}`);
    if (key === 'worstTotal' && value !== r.worstTotal) wrong.push(`worstTotal reads ${r.worstTotal} but MATCH ${row.n} scored ${value}`);
    if (key === 'bestAi' && value !== r.bestScore) wrong.push(`bestAi points at MATCH ${row.n} on ${value}, the batch says best ${r.bestScore}`);
    if (key === 'worstAi' && value !== r.worstScore) wrong.push(`worstAi points at MATCH ${row.n} on ${value}, the batch says worst ${r.worstScore}`);
    if (key === 'bestMargin' && value !== r.bestMargin) wrong.push(`bestMargin points at MATCH ${row.n} on ${value}, the batch says ${r.bestMargin}`);
  }
  const flagged = [...new Set(Object.values(r.at))];
  for (const at of flagged) {
    const row = r.rows[at];
    const again = monteCarlo({ ...common, seed: row.seed, matches: 1, recordFirst: true });
    if (again.rows[0].ai !== row.ai || again.rows[0].opp !== row.opp) {
      wrong.push(`replaying MATCH ${row.n} (seed ${row.seed}) gave ${again.rows[0].ai}-${again.rows[0].opp}, not ${row.ai}-${row.opp}`);
    }
  }
  const first = monteCarlo({ ...common, seed, matches: 1, recordFirst: true });
  if (JSON.stringify(first.recorded.timeline) !== JSON.stringify(r.recorded.timeline)) {
    wrong.push('MATCH 1 does not replay to the frame log the batch recorded, so the page would load a different MATCH than the one it counted');
  }
  if (wrong.length) throw new Error(`batch ladder: ${wrong.join('; ')}`);
  console.log('--- batch ladder (one row per MATCH, extremes named and replayable) ---');
  console.log(`  ${r.rows.length} MATCHes, ${flagged.length} of them at the end of a distribution, and each replays to the scores it was counted at; MATCH 1 comes back as the same ${first.recorded.timeline.length}-anchor log`);
  console.log(`  a MATCH costs ${ms.toFixed(0)} ms with the AI seat searching, so the page's ${max}-MATCH cap is ${(max * ms / 60000).toFixed(1)} min behind the progress bar`);
}

const t0 = Date.now();
const rows = run(30, 20260110);
const greedyMs = (Date.now() - t0) / rows.length;
humanChecks(20260110);
humanChecks(77003);
feedChecks(20260110);
feedChecks(77003);
netChecks(20260110);
passHubChecks(20260110);
seamChecks(20260110);
missLandingChecks(20260110);
dispersionChecks(20260110);
aimChecks(20260110);
hubExitChecks(20260110);
startChecks(20260110);
spacingChecks(20260110);
contactChecks(20260110);
fieldChecks(20260110);
flowChecks(20260110);
batchLadderChecks(20260110);
const totalMs = Date.now() - t0;
summarize(rows);
console.log(`\ntiming: ${greedyMs.toFixed(1)} ms a greedy MATCH (${TIME.matchSec / 0.1} ticks of one engine); this whole run took ${(totalMs / 1000).toFixed(1)} s for its 30 MATCHes plus every check above`);
// Both Table 6-5 columns, named as columns — printing one of them bare is how a DCMP batch ended up
// captioned with the bar it was not graded against. Which of these a rung can still move is measured
// by `npm run rp`, not asserted here.
const reg = rpBars('regional');
const dcmp = rpBars('districtChamp');
console.log(`declared FUEL staged ${FUEL.stagedTotal} | Table 6-5: ENERGIZED ${reg.energized} regional / ${dcmp.energized} district CHAMPIONSHIP, SUPERCHARGED ${reg.supercharged}, TRAVERSAL ${reg.traversal}`);
console.log('\nOK: engine invariants hold.');
