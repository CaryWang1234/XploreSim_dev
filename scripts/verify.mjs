// Headless validation for the REBUILT engine. Runs a naive policy so the checks exercise the
// rules/accounting paths without any AI help. Invariant failures throw; magnitudes are printed
// so the numbers can be compared against the manual's thresholds (Table 6-5).

import { TIME, POINTS, FUEL } from '../web/js/rules.js';
import { defaultScenario, makeAlliance, SAMPLES, periodAt } from '../web/js/model.js';
import { simulateMatch, INTENT, GEO } from '../web/js/engine.js';

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

function summarize(rows) {
  const avg = (f) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  const redWins = rows.filter((r) => r.winner === 'red').length;
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

const t0 = Date.now();
const rows = run(30, 20260110);
const ms = Date.now() - t0;
summarize(rows);
console.log(`\ntiming: ${(ms / rows.length).toFixed(1)} ms per match (tick ${TIME.matchSec / 0.1} steps)`);
console.log('declared FUEL staged', FUEL.stagedTotal, '| ENERGIZED threshold', POINTS.rpThreshold.energized.regional, '| SUPERCHARGED', POINTS.rpThreshold.supercharged.regional);
console.log('\nOK: engine invariants hold.');
