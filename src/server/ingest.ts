import type { IngestBatch, JourneyEvent } from '../shared/types';
import { tx, type DB } from './db';

export const RAGE_WINDOW_MS = 1000;
export const RAGE_RADIUS_PX = 30;
export const RAGE_MIN_CLICKS = 3;
export const DEAD_WINDOW_MS = 1000;
const MAX_EVENTS_PER_BATCH = 5000;
const EVENT_TYPES = new Set(['meta', 'snapshot', 'mutation', 'nav', 'click', 'input', 'scroll', 'move', 'resize', 'error', 'custom', 'visibility']);

export class ValidationError extends Error {}

export function validateBatch(body: unknown): IngestBatch {
  const b = body as IngestBatch;
  if (!b || typeof b !== 'object') throw new ValidationError('body must be an object');
  if (typeof b.sid !== 'string' || !/^[\w-]{8,64}$/.test(b.sid)) throw new ValidationError('invalid sid');
  if (typeof b.vid !== 'string' || !/^[\w-]{8,64}$/.test(b.vid)) throw new ValidationError('invalid vid');
  if (typeof b.seq !== 'number' || !Number.isFinite(b.seq)) throw new ValidationError('invalid seq');
  if (!Array.isArray(b.events)) throw new ValidationError('events must be an array');
  if (b.events.length > MAX_EVENTS_PER_BATCH) throw new ValidationError('too many events');
  // Drop malformed events instead of rejecting the whole batch: partial data beats none.
  b.events = b.events.filter((e) => e && typeof e === 'object' && EVENT_TYPES.has((e as any).type) && typeof (e as any).ts === 'number');
  return b;
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + (u.hash.startsWith('#/') ? u.hash : '');
  } catch {
    return url;
  }
}

export interface IngestResult { duplicate: boolean; accepted: number }

export function ingest(db: DB, batch: IngestBatch, receivedAt = Date.now()): IngestResult {
  return tx(db, () => {
    const dup = db.prepare('INSERT OR IGNORE INTO batches (session_id, seq, received_at) VALUES (?, ?, ?)').run(batch.sid, batch.seq, receivedAt);
    if (dup.changes === 0) return { duplicate: true, accepted: 0 };

    const events = batch.events;
    if (!events.length) return { duplicate: false, accepted: 0 };
    const minTs = Math.min(...events.map((e) => e.ts));
    const maxTs = Math.max(...events.map((e) => e.ts));

    const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(batch.sid);
    if (!existing) {
      db.prepare('INSERT INTO sessions (id, visitor_id, started_at, last_seen_at) VALUES (?, ?, ?, ?)').run(batch.sid, batch.vid, minTs, maxTs);
    }

    const insEvent = db.prepare('INSERT INTO events (session_id, ts, type, data) VALUES (?, ?, ?, ?)');
    const insPage = db.prepare('INSERT INTO pageviews (session_id, ts, url, path, title) VALUES (?, ?, ?, ?, ?)');
    const insSignal = db.prepare('INSERT INTO signals (session_id, ts, kind, detail) VALUES (?, ?, ?, ?)');
    let clicks = 0, errors = 0, pages = 0;
    let userId: string | null = null;
    let meta: Extract<JourneyEvent, { type: 'meta' }> | null = null;
    const clickEvents: Extract<JourneyEvent, { type: 'click' }>[] = [];

    for (const e of events) {
      insEvent.run(batch.sid, e.ts, e.type, JSON.stringify(e));
      if (e.type === 'nav') {
        insPage.run(batch.sid, e.ts, String(e.url), pathOf(String(e.url)), String(e.title || ''));
        pages++;
      } else if (e.type === 'click') {
        clicks++;
        clickEvents.push(e);
      } else if (e.type === 'error') {
        errors++;
        insSignal.run(batch.sid, e.ts, 'error', String(e.msg).slice(0, 300));
      } else if (e.type === 'meta') {
        meta = e;
      } else if (e.type === 'custom' && e.name === 'identify' && e.data && typeof e.data.userId === 'string') {
        userId = e.data.userId;
      }
    }

    // Rage clicks: RAGE_MIN_CLICKS clicks within RAGE_WINDOW_MS and RAGE_RADIUS_PX; counted once per burst.
    let rage = 0;
    const recent = db.prepare("SELECT data FROM events WHERE session_id = ? AND type = 'click' AND ts BETWEEN ? AND ?");
    for (const c of clickEvents) {
      const near = (recent.all(batch.sid, c.ts - RAGE_WINDOW_MS, c.ts) as { data: string }[])
        .map((r) => JSON.parse(r.data))
        .filter((o) => Math.hypot(o.x - c.x, o.y - c.y) <= RAGE_RADIUS_PX);
      if (near.length === RAGE_MIN_CLICKS) {
        rage++;
        insSignal.run(batch.sid, c.ts, 'rage_click', c.sel || c.text);
      }
    }

    // Dead clicks: evaluated once the 1s response window is fully covered by received data.
    const s = db.prepare('SELECT dead_eval_ts, last_seen_at FROM sessions WHERE id = ?').get(batch.sid) as { dead_eval_ts: number; last_seen_at: number };
    const horizon = Math.max(maxTs, s.last_seen_at) - DEAD_WINDOW_MS;
    let dead = 0;
    if (horizon > s.dead_eval_ts) {
      const pending = db.prepare("SELECT ts, data FROM events WHERE session_id = ? AND type = 'click' AND ts > ? AND ts <= ?").all(batch.sid, s.dead_eval_ts, horizon) as { ts: number; data: string }[];
      const response = db.prepare("SELECT 1 FROM events WHERE session_id = ? AND type IN ('mutation','nav','input','snapshot') AND ts > ? AND ts <= ? LIMIT 1");
      for (const p of pending) {
        if (!response.get(batch.sid, p.ts, p.ts + DEAD_WINDOW_MS)) {
          const c = JSON.parse(p.data);
          dead++;
          insSignal.run(batch.sid, p.ts, 'dead_click', c.sel || c.text || '');
        }
      }
    }

    db.prepare(`UPDATE sessions SET
        started_at = MIN(started_at, ?), last_seen_at = MAX(last_seen_at, ?),
        event_count = event_count + ?, click_count = click_count + ?, error_count = error_count + ?,
        page_count = page_count + ?, rage_clicks = rage_clicks + ?, dead_clicks = dead_clicks + ?,
        dead_eval_ts = MAX(dead_eval_ts, ?),
        user_id = COALESCE(?, user_id),
        user_agent = CASE WHEN ? IS NOT NULL THEN ? ELSE user_agent END,
        width = COALESCE(?, width), height = COALESCE(?, height)
      WHERE id = ?`).run(
      minTs, maxTs, events.length, clicks, errors, pages, rage, dead, Math.max(horizon, 0), userId,
      (meta as any)?.ua ?? null, (meta as any)?.ua ?? null, (meta as any)?.w ?? null, (meta as any)?.h ?? null, batch.sid);

    // Entry / exit pages from ordered pageviews (batches can arrive out of order).
    if (pages) {
      db.prepare(`UPDATE sessions SET
          entry_url = (SELECT url FROM pageviews WHERE session_id = ?1 ORDER BY ts ASC LIMIT 1),
          exit_url = (SELECT url FROM pageviews WHERE session_id = ?1 ORDER BY ts DESC LIMIT 1)
        WHERE id = ?1`).run(batch.sid);
    }
    return { duplicate: false, accepted: events.length };
  });
}
