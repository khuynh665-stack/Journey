import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Supervisor } from '../src/server/supervisor';

const script = path.join(__dirname, 'fixtures', 'fake-worker.js');

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

const get = async (port: number) => {
  try { return await (await fetch(`http://127.0.0.1:${port}/readyz`)).text(); } catch { return null; }
};

test('restarts a crashing worker with backoff until it stays up', async () => {
  const port = await freePort();
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sup-')), 'n');
  const sup = new Supervisor({ script, port, env: { FAKE_MODE: 'crash', FAKE_COUNTER: counter }, minBackoffMs: 50, maxBackoffMs: 200, healthIntervalMs: 60_000 });
  sup.start();
  try {
    await waitFor(async () => (await get(port)) === '3');
    assert.equal(sup.restartCount, 2);
    assert.equal(sup.events.filter((e) => e.kind === 'exit').length, 2);
  } finally {
    await sup.stop();
  }
});

test('kills and replaces a worker that fails health probes', async () => {
  const port = await freePort();
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sup-')), 'n');
  const sup = new Supervisor({ script, port, env: { FAKE_MODE: 'unhealthy', FAKE_COUNTER: counter }, minBackoffMs: 50, healthIntervalMs: 100, unhealthyThreshold: 2 });
  sup.start();
  try {
    await waitFor(async () => (await get(port)) === '2');
    assert.ok(sup.events.some((e) => e.kind === 'kill'));
  } finally {
    await sup.stop();
  }
});

test('stop terminates the worker and does not restart it', async () => {
  const port = await freePort();
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sup-')), 'n');
  const sup = new Supervisor({ script, port, env: { FAKE_COUNTER: counter }, minBackoffMs: 50, healthIntervalMs: 60_000 });
  sup.start();
  await waitFor(async () => (await get(port)) === '1');
  await sup.stop();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await get(port), null);
  assert.equal(fs.readFileSync(counter, 'utf8'), '1');
});
