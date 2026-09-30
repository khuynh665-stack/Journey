import type { IngestBatch } from '../shared/types';

/**
 * Delivery with self-healing behaviour:
 *  - exponential backoff with jitter on network errors, 5xx, 408 and 429 (honours Retry-After)
 *  - 413 splits the batch in half and retries each part
 *  - a circuit breaker stops hammering a dead collector and parks batches in an offline outbox
 *  - the outbox lives in localStorage, is size-bounded (oldest dropped first) and drains
 *    on start-up, on the browser 'online' event and whenever a send succeeds
 *  - sendBeacon is used when the page is being unloaded
 */

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface TransportDeps {
  fetch: (url: string, init: RequestInit) => Promise<{ status: number; headers?: { get(k: string): string | null } }>;
  storage: StorageLike | null;
  sendBeacon?: (url: string, data: Blob | string) => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  random: () => number;
  isOnline: () => boolean;
}

export interface TransportConfig {
  endpoint: string;          // e.g. https://collector.example.com/v1/ingest
  ingestKey?: string;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  breakerThreshold: number;  // consecutive failures before the breaker opens
  breakerCooldownMs: number;
  outboxMaxBytes: number;
}

export const DEFAULT_TRANSPORT: Omit<TransportConfig, 'endpoint'> = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  breakerThreshold: 5,
  breakerCooldownMs: 60000,
  outboxMaxBytes: 2_000_000,
};

const OUTBOX_KEY = 'journey:outbox';

export type SendResult = 'sent' | 'queued' | 'dropped';

export class Transport {
  private failures = 0;
  private openUntil = 0;
  private draining = false;
  stats = { sent: 0, retried: 0, queued: 0, dropped: 0 };

  constructor(private cfg: TransportConfig, private deps: TransportDeps) {}

  get breakerOpen(): boolean {
    return this.deps.now() < this.openUntil;
  }

  backoff(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, this.cfg.maxDelayMs);
    const exp = Math.min(this.cfg.maxDelayMs, this.cfg.baseDelayMs * 2 ** attempt);
    return Math.round(exp / 2 + this.deps.random() * (exp / 2)); // "equal jitter"
  }

  private headers(): Record<string, string> {
    // text/plain keeps the request "simple" so browsers skip the CORS preflight.
    const h: Record<string, string> = { 'content-type': 'text/plain;charset=UTF-8' };
    if (this.cfg.ingestKey) h['x-journey-key'] = this.cfg.ingestKey;
    return h;
  }

  private recordFailure(): void {
    this.failures++;
    if (this.failures >= this.cfg.breakerThreshold) {
      this.openUntil = this.deps.now() + this.cfg.breakerCooldownMs;
    }
  }

  private recordSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  async send(batch: IngestBatch): Promise<SendResult> {
    if (!this.deps.isOnline() || this.breakerOpen) {
      this.enqueue(batch);
      return 'queued';
    }
    const result = await this.attempt(batch);
    if (result === 'sent') void this.drain();
    return result;
  }

  private async attempt(batch: IngestBatch): Promise<SendResult> {
    const body = JSON.stringify(batch);
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      if (attempt > 0) this.stats.retried++;
      let status = 0;
      let retryAfter: number | undefined;
      try {
        const res = await this.deps.fetch(this.cfg.endpoint, { method: 'POST', body, headers: this.headers(), keepalive: body.length < 60000 });
        status = res.status;
        const ra = res.headers?.get('retry-after');
        if (ra && !Number.isNaN(Number(ra))) retryAfter = Number(ra) * 1000;
      } catch {
        status = 0; // network error
      }
      if (status >= 200 && status < 300) {
        this.recordSuccess();
        this.stats.sent++;
        return 'sent';
      }
      if (status === 413 && batch.events.length > 1) {
        return this.split(batch);
      }
      const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
      if (!retryable) {
        this.stats.dropped++; // a 4xx will never succeed; do not loop on it
        return 'dropped';
      }
      this.recordFailure();
      if (this.breakerOpen || !this.deps.isOnline()) break;
      if (attempt < this.cfg.maxRetries) await this.deps.sleep(this.backoff(attempt, retryAfter));
    }
    this.enqueue(batch);
    return 'queued';
  }

  private async split(batch: IngestBatch): Promise<SendResult> {
    const mid = Math.ceil(batch.events.length / 2);
    // Sub-batches get fractional sequence numbers so de-duplication on the collector still works.
    const a = await this.attempt({ ...batch, seq: batch.seq + 0.1, events: batch.events.slice(0, mid) });
    const b = await this.attempt({ ...batch, seq: batch.seq + 0.2, events: batch.events.slice(mid) });
    return a === 'sent' && b === 'sent' ? 'sent' : a === 'dropped' && b === 'dropped' ? 'dropped' : 'queued';
  }

  /** Best-effort delivery while the page unloads. Falls back to the outbox. */
  beacon(batch: IngestBatch): void {
    const body = JSON.stringify(batch);
    const ok = this.deps.sendBeacon && !this.breakerOpen && this.deps.sendBeacon(this.cfg.endpoint + (this.cfg.ingestKey ? `?key=${encodeURIComponent(this.cfg.ingestKey)}` : ''), body);
    if (!ok) this.enqueue(batch);
  }

  readOutbox(): IngestBatch[] {
    if (!this.deps.storage) return [];
    try {
      const raw = this.deps.storage.getItem(OUTBOX_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Corrupt outbox (partial write, quota edge case): heal by discarding it.
      try { this.deps.storage.removeItem(OUTBOX_KEY); } catch { /* ignore */ }
      return [];
    }
  }

  private writeOutbox(items: IngestBatch[]): void {
    if (!this.deps.storage) return;
    let list = items;
    let json = JSON.stringify(list);
    while (json.length > this.cfg.outboxMaxBytes && list.length > 0) {
      list = list.slice(1);
      this.stats.dropped++;
      json = JSON.stringify(list);
    }
    try {
      if (list.length) this.deps.storage.setItem(OUTBOX_KEY, json);
      else this.deps.storage.removeItem(OUTBOX_KEY);
    } catch {
      // Quota exceeded: keep the newest half and try once more.
      try { this.deps.storage.setItem(OUTBOX_KEY, JSON.stringify(list.slice(Math.floor(list.length / 2)))); } catch { /* give up */ }
    }
  }

  private enqueue(batch: IngestBatch): void {
    this.stats.queued++;
    if (!this.deps.storage) {
      this.stats.dropped++;
      return;
    }
    this.writeOutbox([...this.readOutbox(), batch]);
  }

  /** Re-send parked batches in order. Stops at the first failure so ordering is preserved. */
  async drain(): Promise<number> {
    if (this.draining || this.breakerOpen || !this.deps.isOnline()) return 0;
    this.draining = true;
    let delivered = 0;
    try {
      let items = this.readOutbox();
      while (items.length) {
        const [head, ...rest] = items;
        this.writeOutbox(rest); // remove first so a crash mid-send cannot duplicate forever (collector de-dupes anyway)
        const r = await this.attemptOnce(head);
        if (r === 'retry') {
          this.writeOutbox([head, ...this.readOutbox()]);
          break;
        }
        if (r === 'sent') delivered++;
        items = this.readOutbox();
      }
    } finally {
      this.draining = false;
    }
    return delivered;
  }

  private async attemptOnce(batch: IngestBatch): Promise<'sent' | 'retry' | 'dropped'> {
    try {
      const res = await this.deps.fetch(this.cfg.endpoint, { method: 'POST', body: JSON.stringify(batch), headers: this.headers() });
      if (res.status >= 200 && res.status < 300) {
        this.recordSuccess();
        this.stats.sent++;
        return 'sent';
      }
      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        this.recordFailure();
        return 'retry';
      }
      this.stats.dropped++;
      return 'dropped';
    } catch {
      this.recordFailure();
      return 'retry';
    }
  }
}
