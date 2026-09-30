import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, purgeOlderThan } from '../src/server/db';
import { ingest, validateBatch, ValidationError } from '../src/server/ingest';
import { funnel, getSession, journeys, overview, searchSessions, stepMatcher } from '../src/server/analytics';
import type { IngestBatch, JourneyEvent } from '../src/shared/types';

let n = 0;
const sid = () => `sess-${String(++n).padStart(8, '0')}`;
const nav = (ts: number, p: string): JourneyEvent => ({ type: 'nav', ts, url: `https://shop.test${p}`, title: p, kind: 'push' });
const click = (ts: number, x = 10, y = 10, sel = '#btn'): JourneyEvent => ({ type: 'click', ts, id: 1, sel, text: 'Go', x, y });
const b = (s: string, seq: number, events: JourneyEvent[]): IngestBatch => ({ sid: s, vid: 'visitor-0001', seq, sdk: 't', events });

test('duplicate batches (retries) are ignored', () => {
  const db = openDb(':memory:');
  const s = sid();
  assert.equal(ingest(db, b(s, 1, [nav(1, '/')])).duplicate, false);
  assert.equal(ingest(db, b(s, 1, [nav(1, '/')])).duplicate, true);
  assert.equal(getSession(db, s)!.session.event_count, 1);
});

test('session summary tracks entry/exit even with out-of-order batches', () => {
  const db = openDb(':memory:');
  const s = sid();
  ingest(db, b(s, 2, [nav(3000, '/cart')]));
  ingest(db, b(s, 1, [{ type: 'meta', ts: 1000, url: 'https://shop.test/', title: '', w: 800, h: 600, ua: 'Chrome/1', ref: '' }, nav(1000, '/')]));
  const r = getSession(db, s)!.session;
  assert.equal(r.entry_url, 'https://shop.test/');
  assert.equal(r.exit_url, 'https://shop.test/cart');
  assert.equal(r.duration_ms, 2000);
  assert.equal(r.page_count, 2);
  assert.equal(r.user_agent, 'Chrome/1');
});

test('rage clicks: 3 clicks within 1s and 30px count once per burst', () => {
  const db = openDb(':memory:');
  const s = sid();
  ingest(db, b(s, 1, [click(1000), click(1200), click(1300, 15, 12), click(1400), click(5000, 500, 500)]));
  assert.equal(getSession(db, s)!.session.rage_clicks, 1);
  // A burst split across two batches is still detected.
  const s2 = sid();
  ingest(db, b(s2, 1, [click(1000), click(1100)]));
  ingest(db, b(s2, 2, [click(1200)]));
  assert.equal(getSession(db, s2)!.session.rage_clicks, 1);
});

test('dead clicks: a click with no DOM change or navigation within 1s', () => {
  const db = openDb(':memory:');
  const s = sid();
  const mutation: JourneyEvent = { type: 'mutation', ts: 1500, m: { adds: [], removes: [], attrs: [{ id: 1, a: { class: 'x' } }], texts: [] } };
  ingest(db, b(s, 1, [click(1000), mutation, click(3000, 200, 200, '#dead')]));
  // The second click's window is not complete yet.
  assert.equal(getSession(db, s)!.session.dead_clicks, 0);
  ingest(db, b(s, 2, [{ type: 'visibility', ts: 4500, hidden: false }]));
  const d = getSession(db, s)!;
  assert.equal(d.session.dead_clicks, 1);
  assert.equal(d.signals.find((x: any) => x.kind === 'dead_click')!.detail, '#dead');
});

test('errors and identify are reflected in the session', () => {
  const db = openDb(':memory:');
  const s = sid();
  ingest(db, b(s, 1, [{ type: 'error', ts: 1, msg: 'boom', src: 'a.js:1', stack: '' }, { type: 'custom', ts: 2, name: 'identify', data: { userId: 'user-42' } }]));
  const r = getSession(db, s)!.session;
  assert.equal(r.error_count, 1);
  assert.equal(r.user_id, 'user-42');
  assert.equal(searchSessions(db, { q: 'user-42' }).total, 1);
  assert.equal(searchSessions(db, { hasError: true }).sessions[0].id, s);
});

test('validation rejects bad batches and drops malformed events', () => {
  assert.throws(() => validateBatch({ sid: 'x', vid: 'visitor-1', seq: 1, events: [] }), ValidationError);
  assert.throws(() => validateBatch(null), ValidationError);
  const v = validateBatch({ sid: 'session-1', vid: 'visitor-1', seq: 1, events: [{ type: 'nope', ts: 1 }, { type: 'click' }, nav(1, '/')] });
  assert.equal(v.events.length, 1);
});

test('funnel counts ordered step completion and samples drop-offs', () => {
  const db = openDb(':memory:');
  const a = sid(), c = sid(), d = sid();
  ingest(db, b(a, 1, [nav(1, '/'), nav(2, '/product/1'), nav(3, '/cart'), nav(4, '/checkout')]));
  ingest(db, b(c, 1, [nav(1, '/'), nav(2, '/product/2'), nav(3, '/cart')]));
  ingest(db, b(d, 1, [nav(1, '/'), nav(2, '/cart')])); // skipped product: never reaches step 2
  const f = funnel(db, ['/', '/product/*', '/cart', '/checkout']);
  assert.deepEqual(f.steps.map((s) => s.sessions), [3, 2, 2, 1]);
  assert.equal(f.steps[3].conversion, 1 / 3);
  assert.equal(f.steps[3].dropoff, 0.5);
  assert.deepEqual(f.steps[2].dropSamples, [c]);
  assert.deepEqual(f.steps[0].dropSamples, [d]);
});

test('funnel steps can be custom events', () => {
  const db = openDb(':memory:');
  const a = sid();
  ingest(db, b(a, 1, [nav(1, '/checkout'), { type: 'custom', ts: 2, name: 'order_placed', data: {} }]));
  assert.deepEqual(funnel(db, ['/checkout', 'event:order_placed']).steps.map((s) => s.sessions), [1, 1]);
});

test('step matcher wildcards and trailing slashes', () => {
  assert.equal(stepMatcher('/product/*')('page', '/product/9'), true);
  assert.equal(stepMatcher('/demo')('page', '/demo/'), true);
  assert.equal(stepMatcher('/demo')('page', '/demo/cart'), false);
  assert.equal(stepMatcher('/a.b')('page', '/axb'), false);
});

test('journeys build a flow graph, common paths and transitions', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 3; i++) ingest(db, b(sid(), 1, [nav(1, '/'), nav(2, '/product/1'), nav(3, '/cart')]));
  ingest(db, b(sid(), 1, [nav(1, '/'), nav(2, '/about')]));
  const g = journeys(db, { depth: 4 });
  assert.equal(g.topPaths[0].sessions, 3);
  assert.deepEqual(g.topPaths[0].path, ['/', '/product/1', '/cart']);
  assert.equal(g.nodes.find((x) => x.id === '0:/')!.sessions, 4);
  assert.equal(g.links.find((l) => l.source === '0:/' && l.target === '1:/product/1')!.sessions, 3);
  assert.ok(g.nodes.some((x) => x.path === '(exit)'));
  assert.equal(g.transitions[0].sessions, 3);
  const from = journeys(db, { startPath: '/product/1' });
  assert.equal(from.nodes.find((x) => x.step === 0)!.path, '/product/1');
});

test('overview aggregates totals, pages and struggles', () => {
  const db = openDb(':memory:');
  ingest(db, b(sid(), 1, [nav(1, '/'), click(10), click(20), click(30)]));
  const o = overview(db) as any;
  assert.equal(o.totals.sessions, 1);
  assert.equal(o.totals.sessions_with_struggle, 1);
  assert.equal(o.topPages[0].path, '/');
  assert.equal(o.struggles[0].kind, 'rage_click');
});

test('retention purge removes old sessions and their data', () => {
  const db = openDb(':memory:');
  const old = sid();
  ingest(db, b(old, 1, [nav(1000, '/')]));
  ingest(db, b(sid(), 1, [nav(Date.now(), '/')]));
  assert.equal(purgeOlderThan(db, Date.now() - 1000), 1);
  assert.equal(getSession(db, old), null);
  assert.equal(searchSessions(db, {}).total, 1);
});

test('a corrupt database file is moved aside and replaced (self-heal)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-'));
  const file = path.join(dir, 'j.db');
  fs.writeFileSync(file, 'this is not a sqlite database'.repeat(200));
  const db = openDb(file);
  ingest(db, b(sid(), 1, [nav(1, '/')]));
  assert.equal(searchSessions(db, {}).total, 1);
  assert.ok(fs.readdirSync(dir).some((f) => f.includes('.corrupt-')));
  db.close();
});

test('a damaged event row does not break session loading', () => {
  const db = openDb(':memory:');
  const s = sid();
  ingest(db, b(s, 1, [nav(1, '/'), nav(2, '/x')]));
  db.prepare("UPDATE events SET data = '{broken' WHERE ts = 2").run();
  const d = getSession(db, s)!;
  assert.equal(d.events.length, 1);
  assert.equal(d.corrupt, 1);
});
