import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Recorder, selectorFor } from '../src/sdk/recorder';
import type { IngestBatch, JourneyEvent } from '../src/shared/types';
import { MemStorage, dom, tick } from './helpers';

function setup(html?: string, cfg: Record<string, unknown> = {}) {
  const w = dom(html ?? `<!doctype html><html><head><title>Shop</title></head><body>
    <button id="buy" class="btn primary">Buy now</button>
    <input id="email" type="email"><input id="q" data-journey-unmask>
    <ul id="list"></ul></body></html>`);
  const sent: IngestBatch[] = [];
  const storage = new MemStorage();
  const rec = new Recorder(w, { endpoint: 'https://c/v1/ingest', flushIntervalMs: 60_000, checkpointMs: 0, ...cfg }, {
    fetch: async (_u, init) => { sent.push(JSON.parse(String(init.body))); return { status: 200 }; },
    storage,
    sleep: async () => {},
  });
  const events = () => sent.flatMap((b) => b.events) as JourneyEvent[];
  return { w, rec, sent, events, storage };
}

test('start emits meta, navigation and a full snapshot', async () => {
  const { rec, events } = setup();
  assert.equal(rec.start(), true);
  await rec.flush();
  const types = events().map((e) => e.type);
  assert.deepEqual(types.slice(0, 3), ['meta', 'nav', 'snapshot']);
  rec.stop();
});

test('clicks carry a selector, text and position', async () => {
  const { w, rec, events } = setup();
  rec.start();
  w.document.getElementById('buy')!.dispatchEvent(new w.MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20 }));
  await rec.flush();
  const c = events().find((e) => e.type === 'click') as any;
  assert.equal(c.sel, '#buy');
  assert.equal(c.text, 'Buy now');
  assert.equal(c.x, 10);
  assert.ok(c.id > 0);
  rec.stop();
});

test('input values are masked unless explicitly unmasked', async () => {
  const { w, rec, events } = setup();
  rec.start();
  const email = w.document.getElementById('email') as HTMLInputElement;
  email.value = 'kim@example.com';
  email.dispatchEvent(new w.Event('input', { bubbles: true }));
  const q = w.document.getElementById('q') as HTMLInputElement;
  q.value = 'boots';
  q.dispatchEvent(new w.Event('input', { bubbles: true }));
  await rec.flush();
  const inputs = events().filter((e) => e.type === 'input') as any[];
  assert.equal(inputs[0].v, '***************');
  assert.equal(inputs[0].masked, true);
  assert.equal(inputs[1].v, 'boots');
  assert.ok(!JSON.stringify(events()).includes('kim@example.com'));
  rec.stop();
});

test('DOM mutations are recorded incrementally', async () => {
  const { w, rec, events } = setup();
  rec.start();
  const li = w.document.createElement('li');
  li.textContent = 'new item';
  w.document.getElementById('list')!.appendChild(li);
  await rec.flush();
  const m = events().find((e) => e.type === 'mutation') as any;
  assert.ok(m, 'mutation event present');
  assert.equal(m.m.adds[0].node.tag, 'li');
  rec.stop();
});

test('SPA navigation via pushState and hash changes is captured', async () => {
  const { w, rec, events } = setup();
  rec.start();
  w.history.pushState({}, '', '/cart');
  w.location.hash = '#promo';
  w.dispatchEvent(new w.HashChangeEvent('hashchange'));
  await rec.flush();
  const navs = events().filter((e) => e.type === 'nav') as any[];
  assert.deepEqual(navs.map((n) => n.kind), ['load', 'push', 'hash']);
  assert.equal(navs[1].url, 'https://shop.example.com/cart');
  rec.stop();
});

test('page errors and unhandled rejections are captured', async () => {
  const { w, rec, events } = setup();
  rec.start();
  w.dispatchEvent(new w.ErrorEvent('error', { message: 'x is undefined', filename: 'app.js', lineno: 3 }));
  await rec.flush();
  const err = events().find((e) => e.type === 'error') as any;
  assert.equal(err.msg, 'x is undefined');
  assert.equal(err.src, 'app.js:3');
  rec.stop();
});

test('sequence numbers increase per flush and persist for the session', async () => {
  const { rec, sent, storage } = setup();
  rec.start();
  await rec.flush();
  rec.track('a');
  await rec.flush();
  assert.deepEqual(sent.map((b) => b.seq), [1, 2]);
  assert.equal(JSON.parse(storage.getItem('journey:session')!).seq, 2);
  rec.stop();
});

test('a session resumes across page loads within the timeout', async () => {
  const a = setup();
  a.rec.start();
  await a.rec.flush();
  a.rec.stop();
  const w2 = dom();
  const rec2 = new Recorder(w2, { endpoint: 'x', checkpointMs: 0 }, { storage: a.storage, fetch: async () => ({ status: 200 }), sleep: async () => {} });
  rec2.start();
  assert.equal(rec2.sessionId, a.rec.sessionId);
  rec2.stop();
});

test('an internal error self-heals by re-snapshotting and never reaches the page', async () => {
  const { w, rec, events } = setup();
  rec.start();
  const original = (rec as any).handleMutations.bind(rec);
  let broken = true;
  (rec as any).handleMutations = (r: MutationRecord[]) => {
    if (broken) { broken = false; throw new Error('boom'); }
    return original(r);
  };
  w.document.body.appendChild(w.document.createElement('div'));
  await tick(); // MutationObserver callback runs here and throws inside the SDK
  await rec.flush();
  const evs = events();
  const sdkErr = evs.find((e) => e.type === 'custom' && e.name === 'sdk_error');
  assert.ok(sdkErr, 'sdk_error reported');
  assert.equal(evs.filter((e) => e.type === 'snapshot').length, 2, 're-snapshot taken');
  assert.equal(rec.running, true);
  rec.stop();
});

test('sampling can exclude a session', () => {
  const { rec } = setup(undefined, { sampleRate: 0 });
  assert.equal(rec.start(), false);
  assert.equal(rec.sampledOut, true);
});

test('stop restores history methods and removes listeners', () => {
  const { w, rec } = setup();
  const push = w.history.pushState;
  rec.start();
  assert.notEqual(w.history.pushState, push);
  rec.stop();
  assert.equal(w.history.pushState, push);
});

test('selectorFor prefers ids and test ids, falls back to a short path', () => {
  const w = dom('<body><div class="card is-active"><span>a</span><span data-testid="price">b</span><span>c</span></div></body>');
  const spans = w.document.querySelectorAll('span');
  assert.equal(selectorFor(spans[1]), '[data-testid="price"]');
  assert.equal(selectorFor(spans[2]), 'body > div.card > span:nth-of-type(3)');
});
