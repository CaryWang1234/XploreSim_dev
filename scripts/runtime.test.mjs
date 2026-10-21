import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parseScouting, placeRosters } from '../web/js/scouting.js';
import { createWorkerClient } from '../web/js/worker-client.js';
import { monteCarlo, matchSeed } from '../web/js/mc.js';
import { DEFAULT_WEIGHTS } from '../web/js/ai.js';
import { SAMPLES, makeAlliance, defaultScenario } from '../web/js/model.js';
import { simulateMatch } from '../web/js/engine.js';
import { greedyPolicy, capOf } from '../web/js/league.js';
import { hubActiveTable } from '../web/js/rules.js';
import { makeContext, emptyPlan, evaluateMatch } from '../web/js/fastsim.js';
import { FieldView } from '../web/js/viz.js';
import { sampleReplay } from '../web/js/replay.js';
import { modeBands, periodBands, robotRows, scoreSeries, sourceRows, strideOf, windowBands } from '../web/js/chartdata.js';
import { SETUP_VERSION, buildSetup, readSetup, encode, decode, toLink } from '../web/js/statestore.js';

test('export retains the last anchor and repeated exports do not degrade a replay', () => {
  const original = Array.from({ length: 12 }, (_, i) => ({ t: i / 10 }));
  const sampled = sampleReplay(original);
  assert.deepEqual(sampled.map((frame) => frame.t), [0, 0.2, 0.4, 0.6, 0.8, 1, 1.1]);
  assert.deepEqual(sampleReplay(sampled), sampled);
  assert.equal(original.length, 12);
  assert.deepEqual(sampleReplay([]), []);
  assert.deepEqual(sampleReplay([{ t: 0 }]), [{ t: 0 }]);
  assert.throws(() => sampleReplay(original, 0), /positive/);
});

class FakeWorker {
  sent = [];
  terminated = false;
  postMessage(message) { this.sent.push(message); }
  terminate() { this.terminated = true; }
  reply(type, payload, extra = {}, id = this.sent.at(-1).id) {
    this.onmessage({ data: { id, type, payload, ...extra } });
  }
}

test('worker routes progress and out-of-order results to the correct request', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(() => worker);
  const progress = [];
  const first = client.ask('mc', {}, (p) => progress.push(p.done));
  const second = client.ask('benchmark', {});
  worker.reply('progress', { done: 1 }, {}, 1);
  worker.reply('result', { score: 2 }, { timeline: [1, 2] }, 2);
  worker.reply('result', { score: 1 }, {}, 1);
  assert.deepEqual(await second, { score: 2, timeline: [1, 2] });
  assert.deepEqual(await first, { score: 1 });
  assert.deepEqual(progress, [1]);
  client.dispose();
});

test('worker crashes reject all callers and the next request uses a fresh worker', async () => {
  const workers = [];
  const client = createWorkerClient(() => { const w = new FakeWorker(); workers.push(w); return w; });
  const first = assert.rejects(client.ask('mc', {}), /crashed/);
  const second = assert.rejects(client.ask('train', {}), /crashed/);
  workers[0].onerror({ message: 'crashed' });
  await Promise.all([first, second]);
  assert.equal(workers[0].terminated, true);
  const retry = client.ask('mc', {});
  workers[1].reply('result', { ok: true });
  assert.deepEqual(await retry, { ok: true });
  client.dispose();
});

test('cancelling a task terminates its worker and ignores late replies', async () => {
  const workers = [];
  const client = createWorkerClient(() => { const w = new FakeWorker(); workers.push(w); return w; });
  const cancelled = assert.rejects(client.ask('mc', {}), { name: 'AbortError' });
  const lateReply = workers[0].onmessage;
  client.dispose(new DOMException('Task cancelled', 'AbortError'));
  await cancelled;
  assert.equal(workers[0].terminated, true);
  const retry = client.ask('mc', {});
  lateReply({ data: { id: 2, type: 'result', payload: { stale: true } } });
  workers[1].reply('result', { fresh: true });
  assert.deepEqual(await retry, { fresh: true });
  client.dispose();
});

test('decode failures release requests, while application errors keep the worker reusable', async () => {
  const worker = new FakeWorker();
  const client = createWorkerClient(() => worker);
  const failed = assert.rejects(client.ask('mc', {}), /invalid inputs/);
  worker.reply('error', 'invalid inputs');
  await failed;
  assert.equal(worker.terminated, false);
  const corrupt = assert.rejects(client.ask('mc', {}), /decode/);
  worker.onmessageerror();
  await corrupt;
  assert.equal(worker.terminated, true);
});

test('worker creation and structured-clone errors reject without poisoning later requests', async () => {
  const worker = new FakeWorker();
  let fail = true;
  const client = createWorkerClient(() => {
    if (fail) { fail = false; throw new Error('blocked'); }
    return worker;
  });
  await assert.rejects(client.ask('mc', {}), /blocked/);
  worker.postMessage = () => { throw new Error('cannot clone'); };
  await assert.rejects(client.ask('mc', {}), /cannot clone/);
  worker.postMessage = FakeWorker.prototype.postMessage;
  const retry = client.ask('mc', {});
  worker.reply('result', { ok: true });
  assert.equal((await retry).ok, true);
  client.dispose();
});

test('Monte Carlo rejects empty, fractional and unbounded batches before simulation', () => {
  for (const matches of [0, -1, 1.5, Infinity, NaN, '2']) {
    assert.throws(() => monteCarlo({ matches }), /matches must be a positive integer/);
  }
  assert.throws(() => monteCarlo({ matches: 1, iterations: 0 }), /iterations/);
  assert.throws(() => monteCarlo({ matches: 1, aiSide: 'green' }), /aiSide/);
});

test('a batch row replays the MATCH it counted, and every extreme points at its own row', () => {
  const common = {
    profilesRed: SAMPLES.slice(0, 3).map((p) => structuredClone(p)),
    profilesBlue: SAMPLES.slice(3, 6).map((p) => structuredClone(p)),
    weights: DEFAULT_WEIGHTS,
    iterations: 60,
    seed: 20260110,
    mode: 'vsBaseline',
    opponentKind: 'greedy',
    aiSide: 'red',
  };
  const r = monteCarlo({ ...common, matches: 3, recordFirst: true });
  assert.deepEqual(r.rows.map((x) => x.n), [1, 2, 3]);
  assert.deepEqual(r.rows.map((x) => x.seed), [0, 1, 2].map((i) => matchSeed(common.seed, i)));
  for (const [key, at] of Object.entries(r.at)) {
    const row = r.rows[at];
    const value = key.endsWith('Ai') ? row.ai : key.endsWith('Opp') ? row.opp
      : key.endsWith('Margin') ? row.margin : row.ai + row.opp;
    if (key === 'bestTotal' || key === 'worstTotal') assert.equal(value, r[key], `${key} disagrees with its row`);
    if (key === 'bestMargin') assert.equal(value, r.bestMargin, `${key} disagrees with its row`);
  }
  const top = r.rows[r.at.bestAi];
  const again = monteCarlo({ ...common, matches: 1, seed: top.seed, recordFirst: true });
  assert.equal(again.rows[0].ai, top.ai);
  assert.equal(again.rows[0].opp, top.opp);
  // Replaying MATCH 1 has to be the same replay the batch recorded, not a re-roll of the same seed family.
  const first = monteCarlo({ ...common, matches: 1, seed: common.seed, recordFirst: true });
  assert.equal(first.rows[0].ai, r.rows[0].ai);
  assert.deepEqual(first.recorded.timeline, r.recorded.timeline);
});

test('static field is rasterized once, reused across frames, and refreshed after size/DPR changes', () => {
  const oldWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 1 };
  let staticPaints = 0;
  let blits = 0;
  const context = () => new Proxy({}, {
    get: (target, key) => key in target ? target[key] : key === 'drawImage' ? () => blits++ : () => {},
    set: (target, key, value) => { target[key] = value; return true; },
  });
  const canvas = {
    parentElement: { clientWidth: 934 }, clientWidth: 900, style: {},
    getContext: () => context(),
    ownerDocument: { createElement: () => ({ getContext: () => context() }) },
  };
  class CountingView extends FieldView {
    drawStatic(ctx) { staticPaints++; super.drawStatic(ctx); }
  }
  try {
    const view = new CountingView(canvas);
    for (let i = 0; i < 120; i++) view.drawFrame(null, null);
    assert.equal(staticPaints, 1);
    assert.equal(blits, 120);
    view.resize();
    assert.equal(staticPaints, 1);
    canvas.parentElement.clientWidth = 734;
    view.resize();
    assert.equal(staticPaints, 2);
    globalThis.window.devicePixelRatio = 2;
    view.resize();
    assert.equal(staticPaints, 3);
    assert.equal(canvas.width, 1400);
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});
test('the single-MATCH flow ledger reaches the page and the live RP ladder reads one computation', () => {
  const common = {
    profilesRed: SAMPLES.slice(0, 3).map((p) => ({ ...p })),
    profilesBlue: SAMPLES.slice(3, 6).map((p) => ({ ...p })),
    weights: DEFAULT_WEIGHTS,
    iterations: 40,
    mode: 'vsBaseline',
    opponentKind: 'greedy',
    aiSide: 'red',
  };
  const { recorded } = monteCarlo({ ...common, seed: 20260110, matches: 1, recordFirst: true });
  // The worker sends a whitelisted subset, so what has to survive is the part the page reads.
  const stats = structuredClone(recorded.robotStats);
  const hubReturned = structuredClone(recorded.hubReturned);
  assert.equal(stats.length, 6);
  for (const s of stats) {
    const cf = s.collectFrom;
    assert.equal(cf.neutral + cf.zone + cf.feed, s.fuelCollected, `${s.name} CORAL sources against what it took`);
    const sec = Object.values(s.modeSec).reduce((a, v) => a + v, 0);
    assert.ok(Math.abs(sec - s.activeSec) <= 0.2, `${s.name} mode seconds against ${s.activeSec} s live`);
    const inches = Object.values(s.modeIn).reduce((a, v) => a + v, 0);
    assert.ok(Math.abs(inches - s.distanceIn) <= 1, `${s.name} mode inches against ${s.distanceIn} in`);
    assert.ok(s.fuelReclaimed <= s.fuelCollected, `${s.name} kept more than it took`);
  }
  assert.ok(hubReturned.red + hubReturned.blue > 0, 'no HUB handed anything back in a MATCH that scored FUEL');
  assert.ok(stats.reduce((a, s) => a + s.fuelReclaimed, 0) > 0, 'nobody reclaimed a piece out of their own HUB returns');
  assert.ok(stats.reduce((a, s) => a + s.modeSec.SCORE, 0) > 0);
  // The scoreboard's live RP line compares the anchor's own counters against these thresholds, so the frame
  // log and the verdict have to agree at the whistle or the line is a second model of the MATCH.
  const th = recorded.final.red.rp.thresholds;
  assert.ok(Number.isFinite(th.energized) && Number.isFinite(th.supercharged) && Number.isFinite(th.traversal));
  const last = recorded.timeline.at(-1);
  for (const side of ['red', 'blue']) {
    assert.equal(last.s[side].fuel, recorded.final[side].fuel, `${side} FUEL on the last anchor against the ledger`);
    assert.equal(last.s[side].tower, recorded.final[side].towerTotal, `${side} TOWER on the last anchor against the ledger`);
    assert.equal(last.s[side].total, recorded.final[side].total);
  }
});

// The four single-MATCH charts are drawn from the anchors, so a line on a canvas has to be the same number as
// the column in the table above it. This runs the derivations the page runs, against the record a MATCH made.
test('the single-MATCH charts derive from the anchors and agree with the ledger they sit under', () => {
  const common = {
    profilesRed: SAMPLES.slice(0, 3).map((p) => ({ ...p })),
    profilesBlue: SAMPLES.slice(3, 6).map((p) => ({ ...p })),
    weights: DEFAULT_WEIGHTS,
    iterations: 40,
    mode: 'vsBaseline',
    opponentKind: 'greedy',
    aiSide: 'red',
  };
  const { recorded } = monteCarlo({ ...common, seed: 20260110, matches: 1, recordFirst: true });
  const tl = structuredClone(recorded.timeline);
  const stats = structuredClone(recorded.robotStats);
  const span = tl.at(-1).t;
  assert.ok(tl.length > 1200, `${tl.length} anchors for a 160 s MATCH is below one per second`);

  for (const side of ['red', 'blue']) {
    const s = scoreSeries(tl, side);
    assert.equal(s.t.at(-1), span, `${side} score series stops short of the whistle`);
    assert.equal(s.v.at(-1), recorded.final[side].total, `${side} trend line ends somewhere other than the scoreboard`);
    assert.ok(s.v.length <= 241, `${side} series draws ${s.v.length} points into a few hundred pixels`);
  }

  const bands = periodBands(tl);
  assert.equal(bands[0].p, 'AUTO');
  assert.equal(bands[0].t0, 0);
  assert.equal(bands.at(-1).t1, span);
  for (let i = 1; i < bands.length; i++) {
    assert.ok(bands[i].t0 <= bands[i - 1].t1 + strideOf(tl), `period bands overlap or leave a hole at ${bands[i].t0}`);
    assert.notEqual(bands[i].p, bands[i - 1].p, 'two neighbouring bands name the same period');
  }

  const stride = strideOf(tl);
  for (const side of ['red', 'blue']) {
    const on = windowBands(tl, side).filter((b) => b.on);
    let sec = 0;
    for (let i = 0; i < on.length; i++) {
      assert.ok(on[i].t1 > on[i].t0, `${side} window band runs backwards`);
      if (i) assert.ok(on[i].t0 >= on[i - 1].t1 - 1e-9, `${side} open windows overlap, so they were merged wrong`);
      sec += on[i].t1 - on[i].t0;
    }
    const counted = tl.reduce((a, f) => a + (f.hub[side] ? stride : 0), 0);
    assert.ok(Math.abs(sec - counted) <= stride * 2, `${side} bands read ${sec.toFixed(1)} s against the ${counted.toFixed(1)} s the note counts`);
    assert.ok(sec > 0 && sec < span, `${side} HUB was open ${sec} s of ${span} s`);
  }

  const rows = robotRows(tl);
  assert.equal(rows.length, stats.length);
  for (const row of rows) {
    const mb = modeBands(tl, row.pos);
    let total = 0;
    const byMode = {};
    for (let i = 0; i < mb.length; i++) {
      if (i) assert.notEqual(mb[i].m, mb[i - 1].m, 'two neighbouring intent bands are the same mode, so the merge missed');
      total += mb[i].t1 - mb[i].t0;
      byMode[mb[i].m] = (byMode[mb[i].m] || 0) + (mb[i].t1 - mb[i].t0);
    }
    assert.ok(Math.abs(total - span) <= stride * 2, `#${row.i} intent bands cover ${total.toFixed(1)} s of a ${span} s MATCH`);
    for (const [m, sec] of Object.entries(byMode)) {
      assert.ok(Math.abs(sec - stats[row.pos].modeSec[m]) <= stride * 3,
        `#${row.i} ${m} reads ${sec.toFixed(1)} s on the band against ${stats[row.pos].modeSec[m].toFixed(1)} s in the table`);
    }
  }

  const src = sourceRows(stats);
  for (let i = 0; i < src.length; i++) {
    assert.equal(src[i].taken, stats[i].fuelCollected);
    assert.equal(src[i].neutral + src[i].zone + src[i].feed, src[i].taken, `${src[i].name} bar does not add up to its own length`);
  }
});

// The autosave and the shareable link are one codec, and its input is somebody's clipboard: a stale
// localStorage entry, a hand-edited URL, a link from a build that no longer exists. Every value coming
// back out has to be re-validated rather than trusted, because a setup is an argument to a physics
// engine — an unchecked object is a way to crash the page from a URL, and an unchecked `__proto__` key
// is a way to write to Object.prototype from one.

const shippedSetup = () => ({
  rosters: { red: SAMPLES.slice(0, 3).map((p) => JSON.parse(JSON.stringify(p))), blue: SAMPLES.slice(3, 6).map((p) => JSON.parse(JSON.stringify(p))) },
  weights: { ...DEFAULT_WEIGHTS },
  scenario: { objective: 'rs', event: 'districtChamp', autoWinner: 'even', towerL1TeleopAllowed: false, faultsEnabled: true, contactFouls: true, humanThrowPerSec: { red: 0.4, blue: 0.5 }, humanAccuracy: { red: 75, blue: 80 } },
  seed: 20260110,
  matches: 120,
  iterations: 200,
  side: 'blue',
  opponent: 'greedy',
});

test('a setup survives bytes and comes back as the same question', () => {
  const built = buildSetup(shippedSetup());
  const { obj, error } = decode(encode(built));
  assert.equal(error, null);
  const { setup, problems } = readSetup(obj);
  assert.deepEqual(problems, [], `the shipped setup should round-trip clean, got ${JSON.stringify(problems)}`);
  assert.deepEqual(setup.rosters.red.map((p) => p.team), [254, 1678, 1690]);
  assert.deepEqual(setup.rosters.blue.map((p) => p.team), [4414, 5940, 11019]);
  assert.equal(setup.scenario.event, 'districtChamp');
  assert.equal(setup.scenario.contactFouls, true);
  assert.equal(setup.scenario.towerL1TeleopAllowed, false);
  assert.equal(setup.seed, 20260110);
  assert.equal(setup.matches, 120);
  assert.equal(setup.side, 'blue');
  assert.equal(setup.opponent, 'greedy');
  // The six cards are the bulk of a link, and a link has to survive being pasted into a chat app.
  const { link, chars, error: linkError } = toLink(built);
  assert.equal(linkError, null);
  assert.ok(link.startsWith('#s='));
  assert.ok(chars < 3000, `a shipped-roster setup is ${chars} characters, over the 3000 a chat app will paste`);
  // A preset card is stored as an index plus its differences, so an untouched card says nothing extra.
  const packed = built.red[0];
  assert.equal(packed.p, 0);
  assert.deepEqual(packed.d, {});
});

test('a card name that is not ASCII survives the same bytes', () => {
  const s = shippedSetup();
  s.rosters.red[0].name = '探索者 Chezy 三号';
  const { setup, problems } = readSetup(decode(encode(buildSetup(s))).obj);
  assert.deepEqual(problems, []);
  assert.equal(setup.rosters.red[0].name, '探索者 Chezy 三号');
  assert.equal(setup.rosters.red[0].team, 254);
});

test('an edited card round-trips through its preset plus the fields that moved', () => {
  const s = shippedSetup();
  s.rosters.red[1].capacity = 44;
  s.rosters.red[1].shootAccuracy = 0.71;
  s.rosters.red[1].climb = { l1: true, l2: true, l3: false, timeSec: 6.5, attachTimeSec: 1.5 };
  s.rosters.red[2].plays = false;
  const packed = buildSetup(s).red[1];
  assert.deepEqual(Object.keys(packed.d).sort(), ['capacity', 'climbTime', 'climbMax', 'shootAccuracy'].sort());
  const { setup } = readSetup(decode(encode(buildSetup(s))).obj);
  assert.equal(setup.rosters.red[1].capacity, 44);
  assert.equal(setup.rosters.red[1].shootAccuracy, 0.71);
  assert.equal(setup.rosters.red[1].climb.l2, true);
  assert.equal(setup.rosters.red[1].climb.l3, false);
  assert.equal(setup.rosters.red[1].climb.timeSec, 6.5);
  assert.equal(setup.rosters.red[2].plays, false);
});

test('a Custom card keeps its own numbers and drops whatever else a link claims', () => {
  // Written as JSON text on purpose: `{ __proto__: {...} }` in an object literal sets the prototype and
  // never becomes an own key, so the literal form would test nothing. A parsed link is the real case —
  // there "__proto__" IS an own enumerable property, and copying it key by key is a prototype write.
  const row = JSON.parse('{"p":-1,"d":{"team":9999,"name":"Mine","capacity":50,"mechanism":"hopper","ref":"not a preset","source":"nowhere","invented":12,"__proto__":{"polluted":"yes"}}}');
  assert.equal(Object.getOwnPropertyNames(row.d).includes('__proto__'), true, 'the fixture is not a parsed link');
  const built = buildSetup(shippedSetup());
  const obj = { v: SETUP_VERSION, red: [row, row, row], blue: built.blue, weights: built.weights, scenario: built.scenario };
  const { setup, problems } = readSetup(obj);
  assert.equal(setup.rosters.red[0].team, 9999);
  assert.equal(setup.rosters.red[0].capacity, 50);
  assert.equal(setup.rosters.red[0].mechanism, 'hopper');
  assert.equal(setup.rosters.red[0].ref, undefined, 'a hand-typed card must not arrive wearing a preset provenance');
  assert.equal(setup.rosters.red[0].source, undefined);
  assert.equal(setup.rosters.red[0].invented, undefined, 'a field no card has got to stay out of the profile');
  assert.ok(problems.some((p) => p.includes('invented')));
  // The pollution attempt has to have been refused, not merely ignored downstream.
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal(Object.getPrototypeOf(setup.rosters.red[0]), Object.prototype);
});

test('out-of-range and wrong-typed values are clamped or refused, and said out loud', () => {
  const row = JSON.parse('{"p":0,"d":{"driveSpeedIps":1000000000,"shootAccuracy":5,"mechanism":"warpengine","climbMax":7,"climbTime":-3,"plays":"yes","heightIn":"tall","__proto__":{"polluted":"yes"},"invented":1}}');
  const built = buildSetup(shippedSetup());
  const { setup, problems } = readSetup({
    v: SETUP_VERSION,
    red: [row, row, row],
    blue: built.blue,
    weights: { ...DEFAULT_WEIGHTS, defenseEfficacy: 44, traversalOverhead: 'x' },
    scenario: { objective: 'money', event: 'districtChamp', contactFouls: 'true' },
  });
  assert.equal(setup.rosters.red[0].driveSpeedIps, 400, 'the domain ceiling is what a link can ask for at most');
  assert.equal(setup.rosters.red[0].shootAccuracy, 0.99);
  assert.equal(setup.rosters.red[0].mechanism, SAMPLES[0].mechanism, 'an unknown shooter keeps the preset');
  assert.equal(setup.rosters.red[0].climb.l1, !!SAMPLES[0].climb.l1, 'climbMax 7 buys no climb');
  assert.equal(setup.rosters.red[0].plays, true, 'a card cannot be benched by a string');
  assert.ok(problems.some((p) => p.includes('driveSpeedIps')));
  assert.ok(problems.some((p) => p.includes('mechanism')));
  assert.ok(problems.some((p) => p.includes('climbMax')));
  assert.ok(problems.some((p) => p.includes('heightIn')));
  assert.ok(problems.some((p) => p.includes('invented')), 'a preset row drops an unknown field quietly');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(setup.rosters.red[0]), Object.prototype);
  assert.ok(problems.some((p) => p.includes('objective')));
  assert.ok(problems.some((p) => p.includes('contactFouls')));
  // A weight outside its domain is refused by clampWeights, which is where the search keeps itself honest.
  assert.equal(setup.weights.defenseEfficacy, 0.9);
  assert.ok(problems.some((p) => p.includes('defenseEfficacy')));
  assert.equal(setup.weights.traversalOverhead, DEFAULT_WEIGHTS.traversalOverhead);
});

// A declared AUTO routine is the one place in this engine where the team's measurement replaces the
// simulation rather than feeding it, so the tests are about the replacement being real: it has to fire,
// it has to be the number that reaches the HUB, it has to move the thing an AUTO actually decides
// (Table 6-3 gives the SHIFT windows to whoever scored less), and it has to leave the shipped build
// exactly where it was when nobody declares anything.

const cloneProfile = (p) => JSON.parse(JSON.stringify(p));
const declaredTrio = (declared) =>
  [SAMPLES[0], SAMPLES[1], SAMPLES[2]].map((p, i) => {
    const q = cloneProfile(p);
    q.auto = { ...(q.auto || {}), routineFuel: declared ? declared[i] : null };
    return q;
  });

const play = (redDeclared, blueDeclared, opts = {}) => {
  const sc = { ...defaultScenario(), seed: 5150, autoRoutine: opts.off ? false : undefined };
  return simulateMatch({
    redAlliance: makeAlliance(declaredTrio(redDeclared), 'red'),
    blueAlliance: makeAlliance(declaredTrio(blueDeclared), 'blue'),
    redPolicy: greedyPolicy('red'),
    bluePolicy: greedyPolicy('blue'),
    scenario: sc,
    record: true,
  });
};

test('a declared AUTO is what scores in AUTO, and nothing is invented to do it', () => {
  const sim = play(null, null);
  const dec = play(null, [40, 40, 40]);
  assert.deepEqual(sim.robotStats.map((s) => s.autoRoutine), Array(6).fill(null), 'an undeclared card must not grow a routine');
  const blue = dec.robotStats.filter((s) => s.alliance === 'blue');
  for (const s of blue) {
    assert.ok(s.autoRoutine, 'the declared card has no routine in the result');
    assert.equal(s.autoRoutine.declared, 40);
    assert.equal(s.autoRoutine.held, 40, 'the machine should start AUTO holding its whole declared load');
    assert.equal(s.autoRoutine.overPreload, 32, 'only 8 of them (§6.3.4-C) could legally be preloaded');
    assert.equal(s.autoRoutine.clampedTo, null, '65 FUEL of capacity holds 40 without clamping');
    assert.ok(s.autoRoutine.banked > 0, 'the routine banked nothing, so the branch never fired');
    assert.ok(s.autoRoutine.banked <= 40, `it banked ${s.autoRoutine.banked} of a declared 40`);
  }
  // Both HUBs are live during AUTO (§6.4.1), so the HUMAN PLAYER's feed lands in the same number the
  // routines do. The routine's own accounting is exact: three declared 40s all go in.
  assert.equal(blue.reduce((a, s) => a + s.autoRoutine.banked, 0), 120, 'a declared load that fits the machine should fire inside the 20 seconds');
  assert.ok(dec.autoFuel.blue >= 120 && dec.autoFuel.blue <= 132, `autoFuel.blue ${dec.autoFuel.blue} is not 120 plus an HUMAN PLAYER feed`);
  assert.ok(dec.autoFuel.blue > sim.autoFuel.blue, `the declaration did not beat the simulated AUTO (${sim.autoFuel.blue} → ${dec.autoFuel.blue})`);
  // The FUEL came off the carpet, it was not conjured: three machines taking on 32 beyond their legal
  // preload leaves 96 fewer pieces lying in the NEUTRAL ZONE at the whistle.
  const looseAt0 = (r) => r.timeline[0].fuel.filter((f) => f[3] !== 4).length;
  assert.equal(looseAt0(sim) - looseAt0(dec), 96, `loose FUEL at t=0 moved by ${looseAt0(sim) - looseAt0(dec)}, not 96`);
});

test('the declaration decides the SHIFT windows, which is what an AUTO is for', () => {
  const sim = play(null, null);
  const dec = play(null, [40, 40, 40]);
  assert.equal(dec.autoWinner, 'blue', `declaring 120 AUTO FUEL on BLUE still did not win AUTO (${dec.autoWinner})`);
  // Table 6-3: the AUTO winner sits its own HUB out in SHIFT 1, so the win has to show up as a dark HUB.
  const shift1 = dec.timeline.find((f) => f.t >= 30.5 && f.t <= 32);
  assert.equal(shift1.hub.blue, false, 'the AUTO winner was not INACTIVE in SHIFT 1');
  assert.equal(shift1.hub.red, true, 'the AUTO loser was not live in SHIFT 1');
  // And the same rule read the other way: the undeclared MATCH follows whatever its own AUTO decided.
  const base1 = sim.timeline.find((f) => f.t >= 30.5 && f.t <= 32);
  assert.notEqual(base1.hub[sim.autoWinner], true, `${sim.autoWinner} won the simulated AUTO and still got a live HUB`);
});

test('a routine over capacity is clamped and says so, and the kill switch is exact', () => {
  const big = play(null, [200, 40, 40]);
  const first = big.robotStats.find((s) => s.alliance === 'blue');
  assert.equal(first.autoRoutine.declared, 200, 'the card stopped being what the user typed');
  assert.equal(first.autoRoutine.held, first.capacity ?? 65, `a 200 declared load on a ${first.capacity}-capacity machine must be clamped`);
  assert.equal(first.autoRoutine.clampedTo, first.capacity ?? 65, 'the clamp was not reported');
  const off = play(null, [40, 40, 40], { off: true });
  const sim = play(null, null);
  assert.deepEqual(off.robotStats.map((s) => s.autoRoutine), Array(6).fill(null), 'the off value still built routines');
  // sc.autoRoutine === false is the ablation arm: every number has to be the one the shipped build has.
  assert.equal(off.final.red.total, sim.final.red.total);
  assert.equal(off.final.blue.total, sim.final.blue.total);
  assert.equal(off.autoFuel.blue, sim.autoFuel.blue);
});

test('the planner uses a declared AUTO instead of a cycle model it cannot see', () => {
  const capsFor = (declared) => makeAlliance(declaredTrio(declared), 'red').robots.map(capOf);
  const estimate = (caps) => {
    const ctx = makeContext({
      schedule: hubActiveTable('red'),
      // `caps` is keyed by side: the same trio on both ALLIANCES, so the only difference between the
      // three calls below is what each side declared for its AUTO.
      caps: { red: caps, blue: caps },
      event: 'regional',
      objective: 'rs',
      weights: DEFAULT_WEIGHTS,
    });
    return evaluateMatch(ctx, 'red', emptyPlan(), emptyPlan()).own.fuel;
  };
  const modelled = estimate(capsFor(null));
  assert.equal(capsFor([40, 40, 40])[0].autoRoutine, 40, 'capOf dropped the declaration on the way to the planner');
  assert.equal(capsFor(null)[0].autoRoutine, null);
  const zero = estimate(capsFor([0, 0, 0]));
  const mid = estimate(capsFor([40, 40, 40]));
  const high = estimate(capsFor([60, 60, 60]));
  const over = estimate(capsFor([200, 200, 200]));
  // The declaration replaces the model rather than adding to it, so the estimate rises with what the team
  // types. It rises by less than the arithmetic: both ALLIANCES draw on the same staged FUEL inside the
  // model (`consume` empties the NEAR pile then the NEUTRAL one), so a machine that takes 20 more in AUTO
  // leaves 20 fewer for its own partners to find later. Sub-additive is the right shape, not a bug.
  assert.ok(mid > zero, `a bigger declared AUTO did not raise the estimate (${zero.toFixed(1)} → ${mid.toFixed(1)})`);
  assert.ok(high > mid && high - mid <= 60, `+20 FUEL a machine moved the estimate by ${(high - mid).toFixed(2)}, outside 0-60`);
  assert.ok(zero < modelled, `declaring an AUTO that scores nothing left the estimate at ${modelled.toFixed(1)}`);
  // Past the hopper the declaration cannot go, and the ceiling is the machine's, not a made-up number.
  assert.ok(Math.abs(over - estimate(capsFor([65, 65, 65]))) < 1e-9, 'a declared load over capacity is not capped by capacity');
  assert.ok(over <= estimate(capsFor([64, 64, 64])) + 1e-9, `a 200 FUEL declaration beat a 64 FUEL hopper (${over.toFixed(1)})`);
});

test('the card ladder takes the machine that earned the second YELLOW, and the absence costs points', () => {
  const contactPlay = (seed, ladder) =>
    simulateMatch({
      redAlliance: makeAlliance(declaredTrio(null), 'red'),
      blueAlliance: makeAlliance(declaredTrio(null), 'blue'),
      redPolicy: greedyPolicy('red'),
      bluePolicy: greedyPolicy('blue'),
      scenario: { ...defaultScenario(), seed, contactFouls: true, cardLadder: ladder },
      record: false,
    });
  let hit = null;
  for (let i = 0; i < 40 && !hit; i++) {
    const seed = 90001 + i * 313;
    const res = contactPlay(seed, true);
    const out = res.robotStats.find((s) => s.dq > 0);
    if (out) hit = { seed, res, out };
  }
  assert.ok(hit, 'no DISQUALIFICATION in 40 MATCHes with contact fouls and the ladder on: the branch never fires');
  const { seed, res, out } = hit;
  assert.equal(out.dq, 1, `the same machine was disqualified ${out.dq} times`);
  assert.ok(out.redCards >= 1, 'a DISQUALIFICATION without a RED CARD is not what §6.6.1 says');
  // Every DQ is a RED, and the second-yellow path converts: the side tally cannot show a DQ it did not card.
  assert.equal(res.cards[out.alliance].dq, res.cards[out.alliance].red, 'a machine was out without a RED CARD counted');
  // And the enforcement changes the MATCH rather than the paperwork: the same seed, same trio, same policy,
  // ladder off, leaves that machine scoring.
  const off = contactPlay(seed, false);
  const twin = off.robotStats.find((s) => s.alliance === out.alliance && s.slot === out.slot);
  assert.equal(twin.dq, 0, 'the off value still disqualified someone');
  assert.ok(twin.fuelScored > out.fuelScored, `the disqualified machine had scored ${out.fuelScored} and ${twin.fuelScored} with the ladder off`);
  // Determinism, because the whole page is replayed from a seed.
  const again = contactPlay(seed, true);
  assert.equal(again.robotStats.reduce((a, s) => a + s.dq, 0), res.robotStats.reduce((a, s) => a + s.dq, 0));
});

test('a scouting CSV lands on the card fields, and what cannot land is said', () => {
  const csv = [
    'Team No,Robot Name,Drive Speed,Speed m/s,Intake Rate,Capacity,Accuracy,Pass Range (m),Height cm,Climb Level,Auto FUEL,Bench,OPR,Notes',
    '11019,Xplore,,4.2,,,,8.5,55,2,26,no,88.4,"wheels bought new"',
    '254,Chezy,152,,12,65,92,380,,21.5,0,8,yes,91.2,',
  ].join('\n');
  const { rows, problems, unknown } = parseScouting(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].team, 11019);
  assert.equal(rows[0].name, 'Xplore');
  // Metric columns are converted into the Manual's inches and seconds (§1.6) rather than read as inches.
  assert.ok(Math.abs(rows[0].driveSpeedIps - 4.2 * 39.3701) < 0.01, `m/s did not convert: ${rows[0].driveSpeedIps}`);
  assert.ok(Math.abs(rows[0].passRangeIn - 8.5 * 39.3701) < 0.01, `metres of reach did not convert: ${rows[0].passRangeIn}`);
  assert.ok(Math.abs(rows[0].heightIn - 55 / 2.54) < 0.01, `cm of height did not convert: ${rows[0].heightIn}`);
  assert.equal(rows[0].climbMax, 2);
  assert.equal(rows[0].autoRoutine, 26);
  assert.equal(rows[0].plays, false, 'a benched row has to arrive benched');
  assert.equal(rows[1].driveSpeedIps, 152);
  assert.equal(rows[1].shootAccuracy, 0.92, 'a percentage column has to become a probability');
  // A column the model has no field for is named, not silently dropped, and it does not fail the import.
  assert.deepEqual(unknown, ['OPR', 'Notes']);
  assert.ok(problems.some((p) => p.includes('OPR')));

  // A number outside the envelope the engine can run is clamped and the clamp is reported; a value that
  // is not a number skips its column rather than writing NaN onto a card.
  const odd = parseScouting('Team No,Height cm,Drive Speed\n1,120,fast');
  assert.equal(odd.rows[0].team, 1);
  assert.equal(odd.rows[0].heightIn, 30, `120 cm became ${odd.rows[0].heightIn} in, unclamped`);
  assert.equal(odd.rows[0].driveSpeedIps, undefined);
  assert.ok(odd.problems.some((p) => p.includes('clamped')), JSON.stringify(odd.problems));
  assert.ok(odd.problems.some((p) => p.includes('not a number')), JSON.stringify(odd.problems));

  // A mechanism this engine has no physics for is refused out loud.
  const bogus = parseScouting('Team No,Mechanism\n1,hopper');
  assert.equal(bogus.rows[0].mechanism, undefined, JSON.stringify(bogus.rows[0]));
  assert.ok(bogus.problems.some((p) => p.includes('not a mechanism')), JSON.stringify(bogus.problems));
});

test('the shipped example file parses, and the rows go where a MATCH can field them', () => {
  const text = readFileSync(new URL('../docs/scouting-example.csv', import.meta.url), 'utf8');
  const { rows, problems } = parseScouting(text);
  assert.equal(rows.length, 3, JSON.stringify(problems));
  assert.deepEqual(problems, [], `the example file should import clean, got ${JSON.stringify(problems)}`);
  assert.equal(rows[0].mechanism, 'turret');
  assert.equal(rows[0].driver, 'good');

  const current = {
    red: [0, 1, 2].map((i) => ({ ...SAMPLES[i] })),
    blue: [3, 4, 5].map((i) => ({ ...SAMPLES[i] })),
  };
  const six = placeRosters([...rows, ...rows.map((r) => ({ ...r, team: r.team - 1 }))], 'red', current);
  assert.equal(six.rosters.red[0].team, 9999);
  assert.equal(six.rosters.blue[0].team, 9998, 'six rows have to fill both ALLIANCES');

  const three = placeRosters(rows, 'blue', current);
  assert.equal(three.rosters.blue[0].team, 9999, 'the seat being planned gets the rows');
  assert.equal(three.rosters.red[0].team, 254, 'the other ALLIANCE keeps its cards');
  // The flat wire names have to land in the nested card objects, or an imported declaration is a key no
  // engine code reads and the card looks right while the MATCH ignores it.
  assert.equal(three.rosters.blue[0].auto.routineFuel, 26);
  assert.equal(three.rosters.blue[0].climb.l1, true);
  assert.equal(three.rosters.blue[0].climb.l2, false, 'the example file climbs to LEVEL 1, not 2');
  assert.equal(three.rosters.blue[0].climb.l3, false);
  assert.equal(three.rosters.blue[0].climb.timeSec, 8);
  assert.equal(three.rosters.blue[0].autoRoutine, undefined, 'the wire name leaked onto the card');
  assert.equal(three.rosters.blue[2].plays, false, 'the third row of the example file is a bench spare');

  const many = placeRosters(rows.concat([{ team: 1 }, { team: 2 }]), 'red', current);
  assert.ok(many.notes.some((n) => n.includes('not fielded')), 'extra rows have to be reported, not dropped quietly');
});

test('a setup that cannot make a MATCH is refused rather than half-applied', () => {
  const built = buildSetup(shippedSetup());
  const bench = { p: 0, d: { plays: false } };
  const { setup, problems } = readSetup({ v: SETUP_VERSION, red: [bench, bench, bench], blue: built.blue, weights: built.weights, scenario: built.scenario });
  assert.ok(problems.some((p) => p.includes('red benched all three')), JSON.stringify(problems));
  // Two cards on a side is not a MATCH either; the side falls back rather than running a 1v2.
  const short = readSetup({ v: SETUP_VERSION, red: built.red.slice(0, 2), blue: built.blue, weights: built.weights, scenario: built.scenario });
  assert.ok(short.problems.some((p) => p.includes('red has 2 ROBOTS')));
  assert.equal(short.setup.rosters.red.length, 3);
});

test('bytes that are not a setup fail with a reason instead of a crash', () => {
  for (const bad of ['', '#s=', '#s=!!!!', '#s=aGVsbG8', 'notbase64url!']) {
    const { obj, error } = decode(bad);
    assert.equal(obj, null, `${bad} decoded`);
    assert.ok(error, `${bad} decoded without a reason`);
  }
  assert.deepEqual(readSetup(null).setup, null);
  const stale = readSetup({ v: 'xplore-setup-v0' });
  assert.equal(stale.setup, null, 'a setup from another version is not this page format');
  assert.match(stale.problems.join(' '), /version/, `a refused version has to say so, got ${JSON.stringify(stale.problems)}`);
  assert.equal(readSetup({ v: SETUP_VERSION }).setup.rosters.red.length, 3, 'a setup with no rosters at all still has to be fieldable');
});

