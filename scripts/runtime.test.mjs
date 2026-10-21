import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerClient } from '../web/js/worker-client.js';
import { monteCarlo, matchSeed } from '../web/js/mc.js';
import { DEFAULT_WEIGHTS } from '../web/js/ai.js';
import { SAMPLES } from '../web/js/model.js';
import { FieldView } from '../web/js/viz.js';
import { sampleReplay } from '../web/js/replay.js';
import { modeBands, periodBands, robotRows, scoreSeries, sourceRows, strideOf, windowBands } from '../web/js/chartdata.js';

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
