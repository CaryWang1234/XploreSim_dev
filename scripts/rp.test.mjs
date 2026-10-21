import assert from 'node:assert/strict';
import test from 'node:test';
import { rpBars } from '../web/js/rules.js';
import { simulateMatch } from '../web/js/engine.js';
import { monteCarlo } from '../web/js/mc.js';
import { SAMPLES, makeAlliance, defaultScenario } from '../web/js/model.js';
import { DEFAULT_WEIGHTS } from '../web/js/ai.js';
import { RP_TERMS, greedyPolicy, smoothUtility, fitnessTrace } from '../web/js/league.js';

// Table 6-5 prints a column per event tier. The build these tests guard shipped with the engine grading
// a district CHAMPIONSHIP batch against the 240 column while every caption beside the rate printed the
// 100 it had not used, and with `smoothUtility` holding 100/360/50 as literals so the tier never reached
// the search either. `scripts/check_web.mjs` keeps the column names out of the other modules' source
// text; these keep the bar the engine grades with, the bar that travels out of a batch, and the bar the
// objective divides by the same number — measured on real MATCHes rather than asserted about constants.

test('rpBars names the column the scenario plays at', () => {
  assert.deepEqual(rpBars('regional'), { event: 'regional', energized: 100, supercharged: 360, traversal: 50 });
  assert.deepEqual(rpBars('districtChamp'), { event: 'districtChamp', energized: 240, supercharged: 360, traversal: 50 });
  // Anything that is not the district CHAMPIONSHIP reads the regional column, which is the scenario default.
  for (const ev of [undefined, null, '', 'regional', 'offseason']) assert.equal(rpBars(ev).energized, 100, `event ${ev}`);
  // ENERGIZED is the only rung with two columns. A reader that assumes otherwise should be caught here.
  assert.equal(rpBars('regional').supercharged, rpBars('districtChamp').supercharged);
  assert.equal(rpBars('regional').traversal, rpBars('districtChamp').traversal);
});

const trio = [SAMPLES[0], SAMPLES[1], SAMPLES[2]];
const greedyMatch = (event, seed = 90001) =>
  simulateMatch({
    redAlliance: makeAlliance(trio, 'red'),
    blueAlliance: makeAlliance(trio, 'blue'),
    redPolicy: greedyPolicy('red'),
    bluePolicy: greedyPolicy('blue'),
    scenario: { ...defaultScenario(), seed, event },
    record: false,
  });

test('the engine grades against that column and carries it out with the verdict', () => {
  for (const [event, energizedBar] of [
    ['regional', 100],
    ['districtChamp', 240],
  ]) {
    const res = greedyMatch(event);
    for (const side of ['red', 'blue']) {
      const rp = res.final[side].rp;
      assert.equal(rp.thresholds.event, event, `${event}: the verdict does not say which column graded it`);
      assert.equal(rp.thresholds.energized, energizedBar, `${event} ${side}: graded at ${rp.thresholds.energized}`);
      // The flag has to follow the bar that travelled with it, not a column re-derived downstream.
      assert.equal(rp.energized, res.final[side].fuel >= energizedBar ? 1 : 0, `${event} ${side}: rp.energized disagrees with its own bar`);
      assert.equal(rp.supercharged, res.final[side].fuel >= rp.thresholds.supercharged ? 1 : 0);
      assert.equal(rp.traversal, res.final[side].towerTotal >= rp.thresholds.traversal ? 1 : 0);
    }
  }
});

test('a batch hands the graded bars to the page rather than the raw table', () => {
  const run = (event) =>
    monteCarlo({
      profilesRed: trio,
      profilesBlue: trio,
      weights: DEFAULT_WEIGHTS,
      seed: 20260110,
      iterations: 40,
      matches: 2,
      recordFirst: false,
      mode: 'vsBaseline',
      aiSide: 'red',
      scenarioOverride: { ...defaultScenario(), event },
    });
  assert.equal(run('districtChamp').thresholds.energized, 240, 'the page would print 100 beside a 240 grading');
  assert.equal(run('regional').thresholds.energized, 100);
  // The per-MATCH rows carry what each MATCH produced in FUEL and TOWER, which is what `rp.mjs` measures
  // a rung's spread over. Without them the audit could only ever re-run MATCHes of its own.
  const r = run('regional');
  assert.equal(r.rows.length, 2);
  for (const row of r.rows) {
    assert.ok(Number.isFinite(row.fuel) && Number.isFinite(row.tower), `row ${row.n} carries ${JSON.stringify(row)}`);
  }
});

const fake = (fuel, tower, total = 600) => ({ final: { red: { total, fuel, towerTotal: tower }, blue: { total: 500, fuel: 0, towerTotal: 0 } } });

test('the objective weights exactly the rungs RP_TERMS declares live', () => {
  const bars = rpBars('regional');
  const liveWeight = Object.values(RP_TERMS).reduce((s, t) => s + (t.live ? t.weight : 0), 0);
  // Clearing every rung against clearing none, at an identical score: the gap is the live weight sum,
  // because a muted rung has to contribute nothing on either side of that difference.
  assert.ok(Math.abs(smoothUtility(fake(9999, 9999), 'red', bars) - smoothUtility(fake(0, 0), 'red', bars) - liveWeight) < 1e-9);
  // Under a bar the live term still has to be fractional rather than a step, which is the whole reason
  // the smooth form exists. TRAVERSAL is the rung that can move, so half of it moves half of it.
  const half = smoothUtility(fake(9999, bars.traversal / 2), 'red', bars) - smoothUtility(fake(0, 0), 'red', bars);
  assert.ok(Math.abs(half - liveWeight / 2) < 1e-9, `half a TOWER rung moved the utility by ${half}`);
  // And a FUEL count under both columns must not be able to move the objective through a muted rung:
  // same MATCH read at either tier gives the same number, because neither FUEL term is live.
  assert.equal(smoothUtility(fake(50, 0), 'red', rpBars('districtChamp')), smoothUtility(fake(50, 0), 'red', rpBars('regional')));
});

test('a FUEL count between the two columns is ENERGIZED at one tier and not at the other', () => {
  const mid = Math.round((rpBars('regional').energized + rpBars('districtChamp').energized) / 2);
  assert.ok(mid > rpBars('regional').energized && mid < rpBars('districtChamp').energized, `${mid} is not between the columns`);
  const at = (event) => (mid >= rpBars(event).energized ? 1 : 0);
  assert.equal(at('regional'), 1);
  assert.equal(at('districtChamp'), 0);
});

test('fitnessTrace is reproducible on a seed set, which is what a paired comparison needs', () => {
  const a = fitnessTrace({ weights: DEFAULT_WEIGHTS, matches: 2, seed: 4242, iterations: 40 });
  const b = fitnessTrace({ weights: DEFAULT_WEIGHTS, matches: 2, seed: 4242, iterations: 40 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 2);
  for (const v of a) assert.ok(Number.isFinite(v));
});
