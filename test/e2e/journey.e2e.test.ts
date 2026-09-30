import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';

/**
 * Full loop in a real browser: the demo shop loads journey.js, a visitor shops, the collector
 * stores the session, and the dashboard replays it.
 */
const root = path.resolve(__dirname, '..', '..');
const port = 4400 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const shots = process.env.E2E_SCREENSHOTS || path.join(root, 'test-results');
let server: ChildProcess;
let browser: Browser;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out ${last ?? ''}`);
}

before(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-e2e-'));
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'dist', 'server.js')], {
    env: { ...process.env, PORT: String(port), JOURNEY_DB: path.join(dataDir, 'j.db'), JOURNEY_ROOT: root, LOG_LEVEL: 'warn' },
    stdio: 'inherit',
  });
  await waitFor(async () => (await fetch(`${base}/readyz`)).ok);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});

after(async () => {
  await browser?.close();
  server?.kill('SIGTERM');
});

test('capture a shopping journey and replay it in the dashboard', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/demo`);
  await page.waitForFunction(() => (window as any).Journey?.sessionId);
  const sid: string = await page.evaluate(() => (window as any).Journey.sessionId);

  await page.click('text=View >> nth=0');
  await page.waitForURL(/product\/1/);
  for (let i = 0; i < 4; i++) await page.click('#wishlist'); // rage + dead click
  await page.waitForTimeout(1100);
  await page.selectOption('#size', 'L');
  await page.click('#add');
  await page.waitForURL(/cart/);
  await page.fill('#coupon', 'SAVE10');
  await page.click('#apply'); // throws inside the page
  await page.click('#checkout');
  await page.fill('input[name=name]', 'Pat Example');
  await page.fill('input[name=email]', 'pat@example.com');
  await page.fill('input[name=card]', '4111111111111111');
  await page.click('text=Place order');
  await page.waitForURL(/thank-you/);
  await page.waitForTimeout(1200);
  await page.evaluate(() => (window as any).Journey.recorder.flush());

  const detail: any = await waitFor(async () => {
    const r = await fetch(`${base}/api/sessions/${sid}`);
    if (!r.ok) return null;
    const d = await r.json();
    return d.session.page_count >= 5 && d.events.some((e: any) => e.type === 'custom' && e.name === 'order_placed') ? d : null;
  });
  const s = detail.session;
  assert.equal(s.error_count, 1, 'coupon error captured');
  assert.ok(s.rage_clicks >= 1, 'rage click detected');
  assert.ok(s.dead_clicks >= 1, 'dead click detected');
  assert.match(s.exit_url, /thank-you/);

  const raw = JSON.stringify(detail);
  assert.ok(!raw.includes('pat@example.com'), 'email never leaves the browser');
  assert.ok(!raw.includes('4111111111111111'), 'card number never leaves the browser');
  assert.ok(!raw.includes('Pat Example'), 'masked-by-default input');
  assert.ok(!raw.includes('12 Elm Street'), 'data-journey-mask text');
  assert.ok(raw.includes('SAVE10'), 'explicitly unmasked input is kept');
  await page.screenshot({ path: path.join(shots, '0-demo-shop.png') });

  // Dashboard: replay the session.
  const dash = await ctx.newPage();
  await dash.goto(`${base}/#/sessions/${sid}`);
  const frame = dash.frameLocator('iframe[title="Session replay"]');
  await frame.locator('text=Acme Outfitters').first().waitFor();
  await dash.locator('.act-nav', { hasText: '/demo/checkout' }).click();
  await frame.locator('h1', { hasText: 'Checkout' }).waitFor();
  const emailInReplay = await frame.locator('input[name=email]').inputValue();
  assert.ok(/^\**$/.test(emailInReplay), `replayed email is masked (got "${emailInReplay}")`);
  await dash.click('button:has-text("Play")');
  await dash.waitForTimeout(1500);
  await dash.screenshot({ path: path.join(shots, '2-replay.png') });

  await dash.goto(`${base}/#/sessions`);
  await dash.locator('tr.clickable').first().waitFor();
  await dash.screenshot({ path: path.join(shots, '1-sessions.png') });

  await dash.goto(`${base}/#/funnels`);
  await dash.locator('.funnel-row').first().waitFor();
  const counts = await dash.locator('.funnel-nums strong').allTextContents();
  assert.deepEqual(counts, ['1', '1', '1', '1', '1']);
  await dash.screenshot({ path: path.join(shots, '4-funnel.png') });

  await dash.goto(`${base}/#/journeys`);
  await dash.locator('svg.sankey rect').first().waitFor();
  await dash.screenshot({ path: path.join(shots, '3-journeys.png') });

  await dash.goto(`${base}/#/`);
  await dash.locator('text=Struggle hotspots').waitFor();
  await dash.screenshot({ path: path.join(shots, '5-overview.png'), fullPage: true });
  await ctx.close();
});

test('the SDK keeps data while the collector is down and delivers it after recovery', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${base}/demo`);
  await page.waitForFunction(() => (window as any).Journey?.sessionId);
  const sid: string = await page.evaluate(() => (window as any).Journey.sessionId);
  await page.evaluate(() => (window as any).Journey.recorder.flush());
  // Simulate an outage: every ingest call fails at the network level.
  await ctx.route('**/v1/ingest', (r) => r.abort('connectionrefused'));
  await page.evaluate(() => {
    const rec = (window as any).Journey.recorder;
    rec.transport.cfg.maxRetries = 1;
    rec.transport.cfg.baseDelayMs = 10;
    (window as any).Journey.track('during_outage', { n: 1 });
    return rec.flush();
  });
  const parked = await page.evaluate(() => JSON.parse(localStorage.getItem('journey:outbox') || '[]').length);
  assert.ok(parked >= 1, 'batch parked in the offline outbox');
  await ctx.unroute('**/v1/ingest');
  await page.evaluate(() => (window as any).Journey.recorder.transport.drain());
  await waitFor(async () => {
    const d = await (await fetch(`${base}/api/sessions/${sid}`)).json();
    return d.events?.some((e: any) => e.name === 'during_outage');
  });
  assert.equal(await page.evaluate(() => localStorage.getItem('journey:outbox')), null);
  await ctx.close();
});
