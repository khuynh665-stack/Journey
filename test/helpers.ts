import { JSDOM } from 'jsdom';

export function dom(html = '<!doctype html><html><head><title>T</title></head><body></body></html>', url = 'https://shop.example.com/home') {
  const jsdom = new JSDOM(html, { url, pretendToBeVisual: true });
  return jsdom.window as unknown as Window & typeof globalThis;
}

/** In-memory Storage with optional quota to exercise overflow paths. */
export class MemStorage {
  data = new Map<string, string>();
  constructor(public quota = Infinity) {}
  getItem(k: string) { return this.data.has(k) ? this.data.get(k)! : null; }
  setItem(k: string, v: string) {
    if (v.length > this.quota) throw new Error('QuotaExceededError');
    this.data.set(k, v);
  }
  removeItem(k: string) { this.data.delete(k); }
}

export const tick = () => new Promise((r) => setTimeout(r, 0));

/** Normalises markup for comparison between a live DOM and its replay. */
export function normalize(html: string): string {
  return html.replace(/\s+/g, ' ').replace(/> </g, '><').trim();
}
