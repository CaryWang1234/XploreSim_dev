import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkerClient } from '../web/js/worker-client.js';
import { monteCarlo } from '../web/js/mc.js';
import { FieldView } from '../web/js/viz.js';
import { sampleReplay } from '../web/js/replay.js';

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
