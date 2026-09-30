import type { IngestBatch, JourneyEvent } from '../shared/types';
import { DEFAULT_PRIVACY, inputValue, isTextMasked, stars, scrub, type PrivacyConfig } from './mask';
import { Mirror, isEmptyMutation, processMutations, serializeNode } from './serializer';
import { DEFAULT_TRANSPORT, Transport, type StorageLike, type TransportConfig, type TransportDeps } from './transport';

export const SDK_VERSION = '1.0.0';

export interface RecorderConfig extends Partial<PrivacyConfig>, Partial<Omit<TransportConfig, 'endpoint'>> {
  endpoint: string;
  sampleRate?: number;          // 0..1 share of sessions recorded
  flushIntervalMs?: number;
  maxBatchEvents?: number;
  sessionTimeoutMs?: number;    // inactivity before a new session starts
  captureMouseMove?: boolean;
  checkpointMs?: number;        // periodic full snapshot so replays can recover from drift
}

interface SessionState { id: string; last: number; seq: number }

const SESSION_KEY = 'journey:session';
const VISITOR_KEY = 'journey:vid';
const MAX_SDK_ERRORS = 20;

function uuid(): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function safeStorage(win: Window): StorageLike | null {
  try {
    const s = win.localStorage;
    s.setItem('journey:probe', '1');
    s.removeItem('journey:probe');
    return s;
  } catch {
    return null;
  }
}

/** CSS selector that is stable enough for analytics grouping (not guaranteed unique). */
export function selectorFor(el: Element | null): string {
  if (!el || el.nodeType !== 1) return '';
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur && depth < 5 && cur.tagName !== 'HTML'; depth++) {
    const testId = cur.getAttribute('data-testid') || cur.getAttribute('data-journey-id');
    if (cur.id && !/\d{3,}/.test(cur.id)) {
      parts.unshift(`#${cur.id}`);
      break;
    }
    if (testId) {
      parts.unshift(`[data-testid="${testId}"]`);
      break;
    }
    let part = cur.tagName.toLowerCase();
    const cls = Array.from(cur.classList).filter((c) => !/\d{3,}|^(is-|has-|active|hover|focus)/.test(c)).slice(0, 2);
    if (cls.length) part += '.' + cls.join('.');
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(' > ');
}

export class Recorder {
  readonly mirror = new Mirror();
  readonly privacy: PrivacyConfig;
  readonly transport: Transport;
  private buffer: JourneyEvent[] = [];
  private observer: MutationObserver | null = null;
  private cleanups: (() => void)[] = [];
  private timers: ReturnType<typeof setInterval>[] = [];
  private session!: SessionState;
  private vid: string;
  private storage: StorageLike | null;
  private sdkErrors = 0;
  private lastUrl = '';
  private throttles = new Map<string, number>();
  running = false;
  sampledOut = false;
  userId: string | null = null;

  constructor(private win: Window, private cfg: RecorderConfig, deps?: Partial<TransportDeps>) {
    this.privacy = { ...DEFAULT_PRIVACY, ...pick(cfg, Object.keys(DEFAULT_PRIVACY) as (keyof PrivacyConfig)[]) };
    this.storage = deps && 'storage' in deps ? deps.storage ?? null : safeStorage(win);
    const nav = win.navigator as Navigator;
    const fullDeps: TransportDeps = {
      fetch: (u, i) => win.fetch(u, i),
      storage: this.storage,
      sendBeacon: nav.sendBeacon ? (u, d) => nav.sendBeacon(u, d) : undefined,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      random: Math.random,
      isOnline: () => nav.onLine !== false,
      ...deps,
    };
    this.transport = new Transport({ ...DEFAULT_TRANSPORT, ...pick(cfg, Object.keys(DEFAULT_TRANSPORT) as any), endpoint: cfg.endpoint } as TransportConfig, fullDeps);
    this.vid = this.load(VISITOR_KEY) || uuid();
    this.save(VISITOR_KEY, this.vid);
  }

  get sessionId(): string {
    return this.session?.id;
  }

  private load(k: string): string | null {
    try { return this.storage?.getItem(k) ?? null; } catch { return null; }
  }
  private save(k: string, v: string): void {
    try { this.storage?.setItem(k, v); } catch { /* storage full or blocked; keep going in memory */ }
  }

  private resumeOrStartSession(): void {
    const timeout = this.cfg.sessionTimeoutMs ?? 30 * 60 * 1000;
    let s: SessionState | null = null;
    try { s = JSON.parse(this.load(SESSION_KEY) || 'null'); } catch { s = null; }
    const now = Date.now();
    if (!s || typeof s.id !== 'string' || now - s.last > timeout) s = { id: uuid(), last: now, seq: 0 };
    this.session = s;
    this.persistSession();
  }

  private persistSession(): void {
    this.save(SESSION_KEY, JSON.stringify(this.session));
  }

  /** Wrap every handler: an exception inside the SDK must never break the host page. */
  private guard<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void {
    return (...a: A) => {
      try {
        fn(...a);
      } catch (e) {
        this.onInternalError(e);
      }
    };
  }

  private onInternalError(e: unknown): void {
    this.sdkErrors++;
    if (this.sdkErrors <= MAX_SDK_ERRORS) {
      this.push({ type: 'custom', ts: Date.now(), name: 'sdk_error', data: { msg: String((e as Error)?.message || e) } });
    }
    // Self-heal: the mirror may have drifted from the DOM, so rebuild it from a fresh snapshot.
    try { this.takeSnapshot(); } catch { /* snapshot itself failing: stop to protect the page */ if (this.sdkErrors > MAX_SDK_ERRORS) this.stop(); }
  }

  start(): boolean {
    if (this.running) return true;
    const rate = this.cfg.sampleRate ?? 1;
    this.resumeOrStartSession();
    // Sampling is decided per session so a sampled session is recorded on every page.
    const bucket = parseInt(this.session.id.replace(/-/g, '').slice(0, 8), 16) / 0xffffffff;
    if (bucket > rate) {
      this.sampledOut = true;
      return false;
    }
    this.running = true;
    const doc = this.win.document;
    const now = Date.now();
    this.push({ type: 'meta', ts: now, url: this.win.location.href, title: doc.title, w: this.win.innerWidth, h: this.win.innerHeight, ua: this.win.navigator.userAgent, ref: doc.referrer });
    this.lastUrl = this.win.location.href;
    this.push({ type: 'nav', ts: now, url: this.lastUrl, title: doc.title, kind: 'load' });
    this.takeSnapshot();
    this.attachListeners();
    this.timers.push(setInterval(this.guard(() => this.flush()), this.cfg.flushIntervalMs ?? 5000));
    if (this.cfg.checkpointMs !== 0) this.timers.push(setInterval(this.guard(() => this.takeSnapshot()), this.cfg.checkpointMs ?? 5 * 60 * 1000));
    void this.transport.drain();
    return true;
  }

  stop(): void {
    if (!this.running) return;
    this.flush();
    this.running = false;
    this.observer?.disconnect();
    this.observer = null;
    this.cleanups.forEach((c) => c());
    this.cleanups = [];
    this.timers.forEach((t) => clearInterval(t));
    this.timers = [];
  }

  takeSnapshot(): void {
    const doc = this.win.document;
    if (this.observer) this.flushMutations(); // do not lose pending changes when re-snapshotting
    this.mirror.reset();
    const node = serializeNode(doc, this.mirror, this.privacy);
    if (node) this.push({ type: 'snapshot', ts: Date.now(), node, sx: this.win.scrollX, sy: this.win.scrollY });
  }

  private flushMutations(): void {
    if (!this.observer) return;
    const records = this.observer.takeRecords();
    if (records.length) this.handleMutations(records);
  }

  private handleMutations(records: MutationRecord[]): void {
    const m = processMutations(records, this.mirror, this.privacy);
    if (!isEmptyMutation(m)) this.push({ type: 'mutation', ts: Date.now(), m });
  }

  private throttled(key: string, ms: number): boolean {
    const now = Date.now();
    const last = this.throttles.get(key) || 0;
    if (now - last < ms) return true;
    this.throttles.set(key, now);
    return false;
  }

  private on(target: EventTarget, type: string, fn: (e: any) => void, opts: AddEventListenerOptions = { capture: true, passive: true }): void {
    const h = this.guard(fn);
    target.addEventListener(type, h, opts);
    this.cleanups.push(() => target.removeEventListener(type, h, opts));
  }

  private checkNav(kind: 'push' | 'replace' | 'pop' | 'hash'): void {
    const url = this.win.location.href;
    if (url === this.lastUrl) return;
    this.lastUrl = url;
    this.push({ type: 'nav', ts: Date.now(), url, title: this.win.document.title, kind });
  }

  private attachListeners(): void {
    const win = this.win;
    const doc = win.document;

    const MO = (win as any).MutationObserver as typeof MutationObserver;
    this.observer = new MO(this.guard((records: MutationRecord[]) => this.handleMutations(records)));
    this.observer.observe(doc, { childList: true, subtree: true, attributes: true, characterData: true });

    this.on(doc, 'click', (e: MouseEvent) => {
      const el = e.target as Element;
      const raw = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const text = isTextMasked(el, this.privacy) ? stars(raw) : scrub(raw, this.privacy);
      this.push({ type: 'click', ts: Date.now(), id: this.mirror.getId(el), sel: selectorFor(el), text, x: e.clientX, y: e.clientY });
    });

    const onInput = (e: Event) => {
      const el = e.target as HTMLInputElement;
      if (!el || !('value' in el)) return;
      const type = (el.getAttribute('type') || '').toLowerCase();
      const raw = type === 'checkbox' || type === 'radio' ? String(el.checked) : String(el.value ?? '');
      const { v, masked } = inputValue(el, raw, this.privacy);
      this.push({ type: 'input', ts: Date.now(), id: this.mirror.getId(el), sel: selectorFor(el), v, masked });
    };
    this.on(doc, 'input', onInput);
    this.on(doc, 'change', onInput);

    this.on(doc, 'scroll', (e: Event) => {
      const t = e.target as any;
      const isDoc = t === doc || t === doc.documentElement || t === doc.body;
      const id = isDoc ? null : this.mirror.getId(t);
      if (this.throttled(`scroll:${id}`, 150)) return;
      const x = isDoc ? win.scrollX : t.scrollLeft;
      const y = isDoc ? win.scrollY : t.scrollTop;
      this.push({ type: 'scroll', ts: Date.now(), id, x, y });
    });

    if (this.cfg.captureMouseMove !== false) {
      this.on(doc, 'mousemove', (e: MouseEvent) => {
        if (this.throttled('move', 100)) return;
        this.push({ type: 'move', ts: Date.now(), x: e.clientX, y: e.clientY });
      });
    }

    this.on(win, 'resize', () => {
      if (this.throttled('resize', 250)) return;
      this.push({ type: 'resize', ts: Date.now(), w: win.innerWidth, h: win.innerHeight });
    });

    this.on(win, 'error', (e: ErrorEvent) => {
      if (!e.message) return; // resource load errors bubble here with no message
      this.push({ type: 'error', ts: Date.now(), msg: scrub(String(e.message), this.privacy).slice(0, 500), src: `${e.filename || ''}:${e.lineno || 0}`, stack: String(e.error?.stack || '').slice(0, 2000) });
    });
    this.on(win, 'unhandledrejection', (e: PromiseRejectionEvent) => {
      const r: any = e.reason;
      this.push({ type: 'error', ts: Date.now(), msg: scrub(String(r?.message || r), this.privacy).slice(0, 500), src: 'unhandledrejection', stack: String(r?.stack || '').slice(0, 2000) });
    });

    // SPA navigation
    const hist = win.history;
    for (const method of ['pushState', 'replaceState'] as const) {
      const original = hist[method];
      const self = this;
      hist[method] = function (this: History, ...args: any[]) {
        const r = original.apply(this, args as any);
        try { self.checkNav(method === 'pushState' ? 'push' : 'replace'); } catch (e) { self.onInternalError(e); }
        return r;
      } as any;
      this.cleanups.push(() => { hist[method] = original; });
    }
    this.on(win, 'popstate', () => this.checkNav('pop'));
    this.on(win, 'hashchange', () => this.checkNav('hash'));

    this.on(doc, 'visibilitychange', () => {
      const hidden = doc.visibilityState === 'hidden';
      this.push({ type: 'visibility', ts: Date.now(), hidden });
      if (hidden) this.flush(true);
    });
    this.on(win, 'pagehide', () => this.flush(true));
    this.on(win, 'online', () => void this.transport.drain());
  }

  push(e: JourneyEvent): void {
    if (!this.running) return;
    this.buffer.push(e);
    this.session.last = e.ts;
    if (this.buffer.length >= (this.cfg.maxBatchEvents ?? 100)) this.flush();
  }

  /** Send buffered events. With unloading=true the beacon API is used. */
  flush(unloading = false): Promise<unknown> | void {
    if (this.observer) {
      const records = this.observer.takeRecords();
      if (records.length) this.handleMutations(records);
    }
    if (!this.buffer.length) return;
    const events = this.buffer;
    this.buffer = [];
    this.session.seq += 1;
    this.session.last = Date.now();
    this.persistSession();
    const batch: IngestBatch = { sid: this.session.id, vid: this.vid, seq: this.session.seq, events, sdk: SDK_VERSION };
    if (unloading) return this.transport.beacon(batch);
    return this.transport.send(batch).catch((e) => this.onInternalError(e));
  }

  identify(userId: string, traits: Record<string, unknown> = {}): void {
    this.userId = userId;
    this.push({ type: 'custom', ts: Date.now(), name: 'identify', data: { userId, ...traits } });
  }

  track(name: string, data: Record<string, unknown> = {}): void {
    this.push({ type: 'custom', ts: Date.now(), name, data });
  }
}

function pick<T extends object, K extends keyof T>(o: any, keys: K[]): Partial<T> {
  const out: any = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}
