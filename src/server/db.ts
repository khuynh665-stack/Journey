import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  user_id TEXT,
  started_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  entry_url TEXT NOT NULL DEFAULT '',
  exit_url TEXT NOT NULL DEFAULT '',
  page_count INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  click_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  rage_clicks INTEGER NOT NULL DEFAULT 0,
  dead_clicks INTEGER NOT NULL DEFAULT 0,
  dead_eval_ts INTEGER NOT NULL DEFAULT 0,
  user_agent TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_visitor ON sessions(visitor_id);

CREATE TABLE IF NOT EXISTS batches (
  session_id TEXT NOT NULL,
  seq REAL NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, ts);

CREATE TABLE IF NOT EXISTS pageviews (
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  url TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pageviews_session ON pageviews(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_pageviews_path ON pageviews(path);

CREATE TABLE IF NOT EXISTS signals (
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_signals_session ON signals(session_id, ts);
CREATE INDEX IF NOT EXISTS idx_signals_kind ON signals(kind, ts);
`;

export type DB = DatabaseSync;

function configure(db: DB): void {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
}

/**
 * Opens the database, self-healing on corruption: a file that fails PRAGMA quick_check
 * is moved aside (kept for forensics) and a fresh database is created so ingestion keeps working.
 */
export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  try {
    const db = new DatabaseSync(file);
    const row = db.prepare('PRAGMA quick_check').get() as { quick_check: string } | undefined;
    if (row && row.quick_check !== 'ok') throw new Error(`quick_check: ${row.quick_check}`);
    configure(db);
    return db;
  } catch (e) {
    if (file === ':memory:') throw e;
    const aside = `${file}.corrupt-${Date.now()}`;
    log.error('database unusable, moving aside and starting fresh', { file, aside, err: String(e) });
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(file + suffix)) fs.renameSync(file + suffix, aside + suffix);
    }
    const db = new DatabaseSync(file);
    configure(db);
    return db;
  }
}

/** Retry a synchronous DB operation on transient lock errors with exponential backoff. */
export function withRetry<T>(fn: () => T, attempts = 5): T {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (!/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(msg)) throw e;
      const until = Date.now() + Math.min(1000, 20 * 2 ** i);
      while (Date.now() < until) { /* short synchronous backoff; DatabaseSync is synchronous */ }
    }
  }
  throw lastErr;
}

export function tx<T>(db: DB, fn: () => T): T {
  return withRetry(() => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw e;
    }
  });
}

export function purgeOlderThan(db: DB, cutoff: number): number {
  return tx(db, () => {
    const ids = (db.prepare('SELECT id FROM sessions WHERE last_seen_at < ?').all(cutoff) as { id: string }[]).map((r) => r.id);
    for (const id of ids) {
      for (const t of ['events', 'pageviews', 'signals', 'batches']) db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(id);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    }
    return ids.length;
  });
}
