import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/collector/app';

let app: App;
let base = '';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-http-'));

before(async () => {
  fs.mkdirSync(path.join(dir, 'public'));
  fs.writeFileSync(path.join(dir, 'public', 'index.html'), '<html>dash</html>');
  fs.writeFileSync(path.join(dir, 'public', 'journey.js'), '/*sdk*/');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope');
  app = createApp({ dbFile: path.join(dir, 'db', 'j.db'), staticDir: path.join(dir, 'public'), ingestKey: 'k1', adminToken: 'admin', maxBodyBytes: 20_000 });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(() => app.close());

const batch = (seq: number) => ({ sid: 'session-http-1', vid: 'visitor-http', seq, sdk: 't', events: [{ type: 'nav', ts: Date.now(), url: 'https://s.test/', title: '', kind: 'load' }] });
const post = (body: unknown, headers: Record<string, string> = { 'x-journey-key': 'k1' }) =>
  fetch(`${base}/v1/ingest`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'text/plain', ...headers } });

test('ingest accepts text/plain JSON with CORS headers', async () => {
  const r = await post(batch(1));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await r.json(), { ok: true, duplicate: false, accepted: 1 });
});

test('ingest key accepted as query parameter (sendBeacon)', async () => {
  const r = await fetch(`${base}/v1/ingest?key=k1`, { method: 'POST', body: JSON.stringify(batch(2)) });
  assert.equal(r.status, 200);
});

test('ingest rejects bad key, bad json, invalid batch and oversize bodies', async () => {
  assert.equal((await post(batch(3), { 'x-journey-key': 'wrong' })).status, 401);
  assert.equal((await post('{nope')).status, 400);
  assert.equal((await post({ sid: 1 })).status, 400);
  assert.equal((await post('x'.repeat(30_000))).status, 413);
});

test('CORS preflight', async () => {
  const r = await fetch(`${base}/v1/ingest`, { method: 'OPTIONS' });
  assert.equal(r.status, 204);
  assert.match(r.headers.get('access-control-allow-headers')!, /x-journey-key/);
});

test('health endpoints', async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const ready = await fetch(`${base}/readyz`);
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).checks.db, 'ok');
  const m = await (await fetch(`${base}/metrics`)).json();
  assert.ok(m.ingested_batches >= 1);
});

test('admin API requires a token', async () => {
  assert.equal((await fetch(`${base}/api/sessions`)).status, 401);
  const r = await fetch(`${base}/api/sessions`, { headers: { authorization: 'Bearer admin' } });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.sessions[0].id, 'session-http-1');
  const one = await fetch(`${base}/api/sessions/session-http-1?token=admin`);
  assert.equal((await one.json()).events.length, 2);
  assert.equal((await fetch(`${base}/api/sessions/missing-id?token=admin`)).status, 404);
  assert.equal((await fetch(`${base}/api/funnel?steps=/&token=admin`)).status, 400);
  assert.equal((await fetch(`${base}/api/funnel?steps=/,/cart&token=admin`)).status, 200);
  assert.equal((await fetch(`${base}/api/journeys?token=admin`)).status, 200);
  assert.equal((await fetch(`${base}/api/overview?token=admin`)).status, 200);
});

test('serves the SDK and dashboard, blocks path traversal', async () => {
  assert.equal(await (await fetch(`${base}/journey.js`)).text(), '/*sdk*/');
  assert.equal(await (await fetch(`${base}/sessions/deep/link`)).text(), '<html>dash</html>');
  const t = await fetch(`${base}/..%2fsecret.txt`);
  assert.notEqual(await t.text(), 'nope');
});

test('storage failure returns 503 so the SDK retries, then the handle self-heals', async () => {
  const realPrepare = app.db.prepare.bind(app.db);
  let fail = 3;
  (app.db as any).prepare = (sql: string) => {
    if (fail > 0 && sql.startsWith('INSERT OR IGNORE INTO batches')) { fail--; throw new Error('disk I/O error'); }
    return realPrepare(sql);
  };
  for (let i = 0; i < 3; i++) {
    const r = await post(batch(100 + i));
    assert.equal(r.status, 503);
    assert.equal(r.headers.get('retry-after'), '5');
  }
  const m = await (await fetch(`${base}/metrics`)).json();
  assert.equal(m.db_reopens, 1);
  assert.equal((await post(batch(200))).status, 200); // new handle works
});
