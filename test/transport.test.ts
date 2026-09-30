import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TRANSPORT, Transport, type TransportDeps } from '../src/sdk/transport';
import type { IngestBatch } from '../src/shared/types';
import { MemStorage } from './helpers';

const batch = (seq: number, n = 2): IngestBatch => ({
  sid: 'session-1234', vid: 'visitor-1234', seq, sdk: 't',
  events: Array.from({ length: n }, (_, i) => ({ type: 'custom', ts: 1000 + i, name: `e${i}`, data: {} })),
});

function harness(statuses: (number | 'throw')[], opts: Partial<TransportDeps> = {}) {
  const calls: { body: IngestBatch }[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const storage = new MemStorage();
  const deps: TransportDeps = {
    fetch: async (_u, init) => {
      calls.push({ body: JSON.parse(String(init.body)) });
      const s = statuses.length ? statuses.shift()! : 200;
      if (s === 'throw') throw new TypeError('network');
      return { status: s, headers: { get: (k: string) => (k === 'retry-after' && s === 429 ? '2' : null) } };
    },
    storage,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    random: () => 0.5,
    isOnline: () => true,
    ...opts,
  };
  const t = new Transport({ ...DEFAULT_TRANSPORT, endpoint: 'https://c/v1/ingest' }, deps);
  return { t, calls, sleeps, storage, advance: (ms: number) => (clock += ms) };
}

test('retries network errors and 5xx with growing backoff, then succeeds', async () => {
  const h = harness(['throw', 503, 500, 200]);
  assert.equal(await h.t.send(batch(1)), 'sent');
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.sleeps, [750, 1500, 3000]); // equal jitter with random()=0.5
  assert.equal(h.t.stats.retried, 3);
});

test('honours Retry-After on 429', async () => {
  const h = harness([429, 200]);
  await h.t.send(batch(1));
  assert.deepEqual(h.sleeps, [2000]);
});

test('4xx is dropped without retrying', async () => {
  const h = harness([400]);
  assert.equal(await h.t.send(batch(1)), 'dropped');
  assert.equal(h.calls.length, 1);
});

test('413 splits the batch in half with distinct sequence numbers', async () => {
  const h = harness([413, 200, 200]);
  assert.equal(await h.t.send(batch(7, 4)), 'sent');
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[1].body.events.length, 2);
  assert.equal(h.calls[2].body.events.length, 2);
  assert.notEqual(h.calls[1].body.seq, h.calls[2].body.seq);
});

test('circuit breaker opens after repeated failures and parks batches offline', async () => {
  const h = harness(Array(20).fill(503));
  assert.equal(await h.t.send(batch(1)), 'queued');
  assert.equal(h.t.breakerOpen, true);
  const before = h.calls.length;
  assert.equal(await h.t.send(batch(2)), 'queued'); // no network call while open
  assert.equal(h.calls.length, before);
  assert.equal(h.t.readOutbox().length, 2);
});

test('outbox drains in order once the collector recovers', async () => {
  const h = harness(Array(5).fill(503)); // exactly enough failures to open the breaker
  await h.t.send(batch(1));
  await h.t.send(batch(2));
  h.advance(DEFAULT_TRANSPORT.breakerCooldownMs + 1);
  const delivered = await h.t.drain();
  assert.equal(delivered, 2);
  const seqs = h.calls.slice(-2).map((c) => c.body.seq);
  assert.deepEqual(seqs, [1, 2]);
  assert.equal(h.t.readOutbox().length, 0);
});

test('offline sends go straight to the outbox', async () => {
  const h = harness([], { isOnline: () => false });
  assert.equal(await h.t.send(batch(1)), 'queued');
  assert.equal(h.calls.length, 0);
});

test('outbox is bounded: oldest batches are dropped first', async () => {
  const h = harness([], { isOnline: () => false });
  const t = new Transport({ ...DEFAULT_TRANSPORT, endpoint: 'x', outboxMaxBytes: 700 }, (h.t as any).deps);
  for (let i = 1; i <= 10; i++) await t.send(batch(i));
  const seqs = t.readOutbox().map((b) => b.seq);
  assert.ok(seqs.length < 10);
  assert.equal(seqs[seqs.length - 1], 10);
});

test('a corrupt outbox is discarded instead of crashing', async () => {
  const h = harness([]);
  h.storage.setItem('journey:outbox', '{not json');
  assert.deepEqual(h.t.readOutbox(), []);
  assert.equal(h.storage.getItem('journey:outbox'), null);
});

test('beacon falls back to the outbox when sendBeacon refuses', () => {
  const h = harness([], { sendBeacon: () => false });
  h.t.beacon(batch(1));
  assert.equal(h.t.readOutbox().length, 1);
});

test('storage quota errors do not throw', async () => {
  const h = harness([], { isOnline: () => false, storage: new MemStorage(10) });
  assert.equal(await h.t.send(batch(1)), 'queued');
});
