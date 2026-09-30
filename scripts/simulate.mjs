// Generates realistic demo sessions by driving the demo shop in a headless browser.
// Usage: node scripts/simulate.mjs [baseUrl] [sessions]
import { chromium } from 'playwright-core';

const base = process.argv[2] || 'http://localhost:4400';
const count = Number(process.argv[3] || 12);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sizes = [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 1024, height: 768 }];

for (let i = 0; i < count; i++) {
  const ctx = await browser.newContext({ viewport: pick(sizes) });
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}/demo`);
    await page.waitForFunction(() => window.Journey?.sessionId);
    await page.mouse.move(200, 300, { steps: 8 });
    const r = Math.random();
    if (r < 0.15) { await page.waitForTimeout(800); continue; } // bounce
    await page.click(`text=View >> nth=${Math.floor(Math.random() * 4)}`);
    await page.waitForTimeout(400 + Math.random() * 800);
    if (Math.random() < 0.35) for (let k = 0; k < 3 + Math.floor(Math.random() * 3); k++) await page.click('#wishlist');
    if (r < 0.3) { await page.goBack(); await page.waitForTimeout(500); continue; }
    await page.selectOption('#size', pick(['S', 'M', 'L']));
    await page.click('#add');
    await page.waitForTimeout(500);
    if (Math.random() < 0.4) { await page.fill('#coupon', pick(['SAVE10', 'FREESHIP', 'WELCOME'])); await page.click('#apply'); }
    if (r < 0.5) { await page.waitForTimeout(600); continue; } // abandons cart
    await page.click('#checkout');
    await page.fill('input[name=name]', 'Sam Sample');
    await page.fill('input[name=email]', 'sam@example.com');
    if (r < 0.65) { await page.waitForTimeout(600); continue; } // abandons checkout
    await page.fill('input[name=card]', '4242424242424242');
    await page.click('text=Place order');
    await page.waitForTimeout(800);
  } finally {
    await page.evaluate(() => window.Journey?.recorder?.flush()).catch(() => {});
    await page.waitForTimeout(200);
    await ctx.close();
  }
  process.stdout.write('.');
}
await browser.close();
console.log(`\ncreated ${count} sessions`);
