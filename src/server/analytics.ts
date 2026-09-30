import type { JourneyEvent, SessionSummary } from '../shared/types';
import type { DB } from './db';

const SESSION_COLS = `id, visitor_id, user_id, started_at, last_seen_at, last_seen_at - started_at AS duration_ms,
  entry_url, exit_url, page_count, event_count, click_count, error_count, rage_clicks, dead_clicks, user_agent`;

export interface SessionQuery {
  q?: string;            // free text: session id, visitor id, user id, url
  url?: string;          // visited a page whose url contains this
  hasError?: boolean;
  struggle?: boolean;    // rage or dead clicks
  from?: number;
  to?: number;
  minDurationMs?: number;
  limit?: number;
  offset?: number;
}

export function searchSessions(db: DB, q: SessionQuery): { total: number; sessions: SessionSummary[] } {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (q.q) {
    where.push('(id LIKE ? OR visitor_id LIKE ? OR user_id LIKE ? OR entry_url LIKE ? OR exit_url LIKE ?)');
    const like = `%${q.q}%`;
    args.push(like, like, like, like, like);
  }
  if (q.url) {
    where.push('EXISTS (SELECT 1 FROM pageviews p WHERE p.session_id = sessions.id AND p.url LIKE ?)');
    args.push(`%${q.url}%`);
  }
  if (q.hasError) where.push('error_count > 0');
  if (q.struggle) where.push('(rage_clicks > 0 OR dead_clicks > 0)');
  if (q.from) { where.push('started_at >= ?'); args.push(q.from); }
  if (q.to) { where.push('started_at <= ?'); args.push(q.to); }
  if (q.minDurationMs) { where.push('last_seen_at - started_at >= ?'); args.push(q.minDurationMs); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM sessions ${w}`).get(...args) as { n: number }).n;
  const sessions = db.prepare(`SELECT ${SESSION_COLS} FROM sessions ${w} ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as unknown as SessionSummary[];
  return { total, sessions };
}

export function getSession(db: DB, id: string) {
  const session = db.prepare(`SELECT ${SESSION_COLS} FROM sessions WHERE id = ?`).get(id) as SessionSummary | undefined;
  if (!session) return null;
  const events: JourneyEvent[] = [];
  let corrupt = 0;
  for (const r of db.prepare('SELECT data FROM events WHERE session_id = ? ORDER BY ts, id').all(id) as { data: string }[]) {
    try { events.push(JSON.parse(r.data)); } catch { corrupt++; } // skip a damaged row, keep the replay
  }
  const pages = db.prepare('SELECT ts, url, path, title FROM pageviews WHERE session_id = ? ORDER BY ts').all(id);
  const signals = db.prepare('SELECT ts, kind, detail FROM signals WHERE session_id = ? ORDER BY ts').all(id);
  return { session, events, pages, signals, corrupt };
}

/** Converts a funnel step pattern into a matcher. Supports `*` wildcards on paths and `event:<name>` custom events. */
export function stepMatcher(step: string): (kind: 'page' | 'event', value: string) => boolean {
  if (step.startsWith('event:')) {
    const name = step.slice(6);
    return (kind, v) => kind === 'event' && v === name;
  }
  const re = new RegExp('^' + step.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '/?$');
  return (kind, v) => kind === 'page' && re.test(v);
}

export interface FunnelResult {
  steps: { step: string; sessions: number; conversion: number; dropoff: number; dropSamples: string[] }[];
  total: number;
}

export function funnel(db: DB, steps: string[], from = 0, to = Number.MAX_SAFE_INTEGER): FunnelResult {
  const matchers = steps.map(stepMatcher);
  const counts = new Array(steps.length).fill(0);
  const dropSamples: string[][] = steps.map(() => []);
  const rows = db.prepare(`
      SELECT session_id, ts, 'page' AS kind, path AS v FROM pageviews WHERE session_id IN (SELECT id FROM sessions WHERE started_at BETWEEN ?1 AND ?2)
      UNION ALL
      SELECT session_id, ts, 'event' AS kind, json_extract(data, '$.name') AS v FROM events WHERE type = 'custom' AND session_id IN (SELECT id FROM sessions WHERE started_at BETWEEN ?1 AND ?2)
      ORDER BY session_id, ts`).all(from, to) as { session_id: string; kind: 'page' | 'event'; v: string }[];

  let current: string | null = null;
  let reached = 0;
  const finish = () => {
    if (current === null) return;
    for (let i = 0; i < reached; i++) counts[i]++;
    if (reached > 0 && reached < steps.length && dropSamples[reached - 1].length < 10) dropSamples[reached - 1].push(current);
  };
  for (const r of rows) {
    if (r.session_id !== current) {
      finish();
      current = r.session_id;
      reached = 0;
    }
    if (reached < steps.length && matchers[reached](r.kind, r.v)) reached++;
  }
  finish();

  const total = counts[0] || 0;
  return {
    total,
    steps: steps.map((step, i) => ({
      step,
      sessions: counts[i],
      conversion: total ? counts[i] / total : 0,
      dropoff: i === 0 ? 0 : counts[i - 1] ? 1 - counts[i] / counts[i - 1] : 0,
      dropSamples: dropSamples[i],
    })),
  };
}

export interface JourneyGraph {
  nodes: { id: string; step: number; path: string; sessions: number }[];
  links: { source: string; target: string; sessions: number }[];
  topPaths: { path: string[]; sessions: number }[];
  transitions: { from: string; to: string; sessions: number }[];
}

/** Aggregates page sequences into a step-by-step flow (for a Sankey) plus the most common full paths. */
export function journeys(db: DB, opts: { depth?: number; width?: number; from?: number; to?: number; startPath?: string } = {}): JourneyGraph {
  const depth = Math.min(opts.depth ?? 5, 10);
  const width = Math.min(opts.width ?? 6, 20);
  const rows = db.prepare(`SELECT session_id, path FROM pageviews WHERE session_id IN (SELECT id FROM sessions WHERE started_at BETWEEN ? AND ?) ORDER BY session_id, ts`)
    .all(opts.from ?? 0, opts.to ?? Number.MAX_SAFE_INTEGER) as { session_id: string; path: string }[];
  const seqs = new Map<string, string[]>();
  for (const r of rows) {
    const s = seqs.get(r.session_id) || [];
    if (s[s.length - 1] !== r.path) s.push(r.path); // collapse reloads
    seqs.set(r.session_id, s);
  }
  let paths = Array.from(seqs.values());
  if (opts.startPath) {
    paths = paths.map((p) => p.slice(Math.max(p.indexOf(opts.startPath!), 0))).filter((p) => p[0] === opts.startPath);
  }

  const pathCounts = new Map<string, number>();
  const transitions = new Map<string, number>();
  for (const p of paths) {
    const key = p.slice(0, depth).join(' → ');
    pathCounts.set(key, (pathCounts.get(key) || 0) + 1);
    for (let i = 0; i + 1 < p.length; i++) {
      const k = `${p[i]}\u0000${p[i + 1]}`;
      transitions.set(k, (transitions.get(k) || 0) + 1);
    }
  }

  // Keep the `width` most common pages per step; the rest become "(other)". Sessions ending get "(exit)".
  const perStep: Map<string, number>[] = Array.from({ length: depth }, () => new Map());
  for (const p of paths) for (let i = 0; i < Math.min(p.length, depth); i++) perStep[i].set(p[i], (perStep[i].get(p[i]) || 0) + 1);
  const keep = perStep.map((m) => new Set(Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, width).map(([k]) => k)));
  const label = (i: number, p: string) => (keep[i].has(p) ? p : '(other)');

  const nodeMap = new Map<string, { id: string; step: number; path: string; sessions: number }>();
  const linkMap = new Map<string, number>();
  for (const p of paths) {
    const n = Math.min(p.length, depth);
    for (let i = 0; i < n; i++) {
      const id = `${i}:${label(i, p[i])}`;
      const node = nodeMap.get(id) || { id, step: i, path: label(i, p[i]), sessions: 0 };
      node.sessions++;
      nodeMap.set(id, node);
      if (i + 1 < n) {
        const lk = `${id}\u0000${i + 1}:${label(i + 1, p[i + 1])}`;
        linkMap.set(lk, (linkMap.get(lk) || 0) + 1);
      } else if (i + 1 < depth) {
        const exitId = `${i + 1}:(exit)`;
        const exit = nodeMap.get(exitId) || { id: exitId, step: i + 1, path: '(exit)', sessions: 0 };
        exit.sessions++;
        nodeMap.set(exitId, exit);
        linkMap.set(`${id}\u0000${exitId}`, (linkMap.get(`${id}\u0000${exitId}`) || 0) + 1);
      }
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    links: Array.from(linkMap.entries()).map(([k, sessions]) => {
      const [source, target] = k.split('\u0000');
      return { source, target, sessions };
    }),
    topPaths: Array.from(pathCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, sessions]) => ({ path: k.split(' → '), sessions })),
    transitions: Array.from(transitions.entries()).sort((a, b) => b[1] - a[1]).slice(0, 50).map(([k, sessions]) => {
      const [from, to] = k.split('\u0000');
      return { from, to, sessions };
    }),
  };
}

export function overview(db: DB, from = 0, to = Number.MAX_SAFE_INTEGER) {
  const totals = db.prepare(`SELECT COUNT(*) AS sessions, COUNT(DISTINCT visitor_id) AS visitors,
      COALESCE(AVG(last_seen_at - started_at), 0) AS avg_duration_ms,
      COALESCE(SUM(page_count), 0) AS pageviews,
      COALESCE(SUM(CASE WHEN error_count > 0 THEN 1 ELSE 0 END), 0) AS sessions_with_errors,
      COALESCE(SUM(CASE WHEN rage_clicks + dead_clicks > 0 THEN 1 ELSE 0 END), 0) AS sessions_with_struggle
    FROM sessions WHERE started_at BETWEEN ? AND ?`).get(from, to);
  const topPages = db.prepare(`SELECT path, COUNT(*) AS views, COUNT(DISTINCT session_id) AS sessions FROM pageviews
    WHERE ts BETWEEN ? AND ? GROUP BY path ORDER BY views DESC LIMIT 10`).all(from, to);
  const topErrors = db.prepare(`SELECT detail AS message, COUNT(*) AS occurrences, COUNT(DISTINCT session_id) AS sessions, MAX(session_id) AS sample_session
    FROM signals WHERE kind = 'error' AND ts BETWEEN ? AND ? GROUP BY detail ORDER BY occurrences DESC LIMIT 10`).all(from, to);
  const struggles = db.prepare(`SELECT kind, detail AS target, COUNT(*) AS occurrences, COUNT(DISTINCT session_id) AS sessions, MAX(session_id) AS sample_session
    FROM signals WHERE kind IN ('rage_click','dead_click') AND ts BETWEEN ? AND ? GROUP BY kind, detail ORDER BY occurrences DESC LIMIT 10`).all(from, to);
  const daily = db.prepare(`SELECT date(started_at / 1000, 'unixepoch') AS day, COUNT(*) AS sessions FROM sessions
    WHERE started_at BETWEEN ? AND ? GROUP BY day ORDER BY day`).all(from, to);
  return { totals, topPages, topErrors, struggles, daily };
}
