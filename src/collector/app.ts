import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { openDb, purgeOlderThan, type DB } from './db';
import { ingest, validateBatch, ValidationError } from './ingest';
import { funnel, getSession, journeys, overview, searchSessions } from './analytics';
import { log } from './log';

export interface AppConfig {
  dbFile: string;
  staticDir?: string;          // built dashboard + journey.js
  demoDir?: string;            // demo site
  ingestKey?: string;          // required on /v1/ingest when set
  adminToken?: string;         // required on /api/* when set
  maxBodyBytes?: number;
  retentionDays?: number;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
};

class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(json);
}

function readBody(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) return reject(new HttpError(413, 'payload too large'));
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function num(v: string | null): number | undefined {
  if (v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, x-journey-key',
  'access-control-max-age': '86400',
};

export interface App {
  server: http.Server;
  db: DB;
  health(): { ok: boolean; checks: Record<string, unknown> };
  close(): Promise<void>;
}

export function createApp(cfg: AppConfig): App {
  let db = openDb(cfg.dbFile);
  const maxBody = cfg.maxBodyBytes ?? 5 * 1024 * 1024;
  const started = Date.now();
  const metrics = { ingested_batches: 0, ingested_events: 0, duplicates: 0, rejected: 0, errors: 0, db_reopens: 0 };
  let consecutiveDbErrors = 0;

  // Event-loop lag probe: a blocked loop is reported as unhealthy so the supervisor can restart us.
  let lag = 0;
  let lastTick = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    lag = Math.max(0, now - lastTick - 500);
    lastTick = now;
  }, 500);
  lagTimer.unref();

  const retentionTimer = setInterval(() => {
    if (!cfg.retentionDays) return;
    try {
      const n = purgeOlderThan(db, Date.now() - cfg.retentionDays * 86400000);
      if (n) log.info('retention purge', { sessions: n });
    } catch (e) {
      log.warn('retention purge failed', { err: String(e) });
    }
  }, 3600_000);
  retentionTimer.unref();

  /** Self-heal: after repeated DB failures, close and reopen the handle (runs corruption checks again). */
  function onDbError(e: unknown): void {
    consecutiveDbErrors++;
    log.error('database error', { err: String(e), consecutive: consecutiveDbErrors });
    if (consecutiveDbErrors >= 3) {
      try { db.close(); } catch { /* ignore */ }
      db = openDb(cfg.dbFile);
      app.db = db;
      metrics.db_reopens++;
      consecutiveDbErrors = 0;
      log.warn('database handle reopened');
    }
  }

  function health() {
    const checks: Record<string, unknown> = { uptime_s: Math.round((Date.now() - started) / 1000), event_loop_lag_ms: lag };
    let ok = true;
    try {
      db.prepare('SELECT 1').get();
      checks.db = 'ok';
    } catch (e) {
      checks.db = String(e);
      ok = false;
    }
    if (lag > 2000) ok = false;
    return { ok, checks };
  }

  function authorizedAdmin(req: http.IncomingMessage, url: URL): boolean {
    if (!cfg.adminToken) return true;
    const h = req.headers.authorization || '';
    return h === `Bearer ${cfg.adminToken}` || url.searchParams.get('token') === cfg.adminToken;
  }

  function serveStatic(res: http.ServerResponse, dir: string, rel: string, fallback?: string): boolean {
    const root = path.resolve(dir);
    let file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
    if (!file.startsWith(root)) return false; // path traversal
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (fs.existsSync(path.join(file, 'index.html'))) file = path.join(file, 'index.html');
      else if (fallback && fs.existsSync(path.join(root, fallback))) file = path.join(root, fallback);
      else return false;
    }
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300', 'access-control-allow-origin': '*' });
    fs.createReadStream(file).pipe(res);
    return true;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://localhost');
    const p = url.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p === '/readyz') {
      const h = health();
      return send(res, h.ok ? 200 : 503, h);
    }
    if (p === '/metrics') return send(res, 200, { ...metrics, ...health().checks });

    if (p === '/v1/ingest' && req.method === 'POST') {
      const key = (req.headers['x-journey-key'] as string) || url.searchParams.get('key');
      if (cfg.ingestKey && key !== cfg.ingestKey) {
        metrics.rejected++;
        return send(res, 401, { error: 'bad ingest key' }, CORS);
      }
      let raw = await readBody(req, maxBody);
      if (req.headers['content-encoding'] === 'gzip') raw = zlib.gunzipSync(raw);
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        metrics.rejected++;
        return send(res, 400, { error: 'invalid json' }, CORS);
      }
      const batch = validateBatch(body);
      try {
        const r = ingest(db, batch);
        consecutiveDbErrors = 0;
        if (r.duplicate) metrics.duplicates++;
        else { metrics.ingested_batches++; metrics.ingested_events += r.accepted; }
        return send(res, 200, { ok: true, ...r }, CORS);
      } catch (e) {
        onDbError(e);
        // 503 tells the SDK to back off and retry; its outbox keeps the data meanwhile.
        return send(res, 503, { error: 'storage unavailable' }, { ...CORS, 'retry-after': '5' });
      }
    }

    if (p.startsWith('/api/')) {
      if (!authorizedAdmin(req, url)) return send(res, 401, { error: 'unauthorized' });
      const qs = url.searchParams;
      const range = { from: num(qs.get('from')), to: num(qs.get('to')) };
      if (p === '/api/sessions') {
        return send(res, 200, searchSessions(db, {
          q: qs.get('q') || undefined, url: qs.get('url') || undefined,
          hasError: qs.get('hasError') === '1', struggle: qs.get('struggle') === '1',
          ...range, minDurationMs: num(qs.get('minDuration')), limit: num(qs.get('limit')), offset: num(qs.get('offset')),
        }));
      }
      const m = p.match(/^\/api\/sessions\/([\w-]+)$/);
      if (m) {
        const s = getSession(db, m[1]);
        return s ? send(res, 200, s) : send(res, 404, { error: 'not found' });
      }
      if (p === '/api/funnel') {
        const steps = (qs.get('steps') || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (steps.length < 2) throw new HttpError(400, 'provide at least two comma-separated steps');
        return send(res, 200, funnel(db, steps, range.from, range.to));
      }
      if (p === '/api/journeys') {
        return send(res, 200, journeys(db, { depth: num(qs.get('depth')), width: num(qs.get('width')), startPath: qs.get('start') || undefined, ...range }));
      }
      if (p === '/api/overview') return send(res, 200, overview(db, range.from, range.to));
      return send(res, 404, { error: 'not found' });
    }

    if (req.method === 'GET') {
      if (p === '/journey.js' && cfg.staticDir && serveStatic(res, cfg.staticDir, 'journey.js')) return;
      if (p.startsWith('/demo') && cfg.demoDir && serveStatic(res, cfg.demoDir, p.slice(5) || '/', 'index.html')) return;
      if (cfg.staticDir && serveStatic(res, cfg.staticDir, p, 'index.html')) return;
    }
    send(res, 404, { error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message }, CORS);
      if (e instanceof ValidationError) {
        metrics.rejected++;
        return send(res, 400, { error: e.message }, CORS);
      }
      metrics.errors++;
      log.error('request failed', { url: req.url, err: String(e?.stack || e) });
      send(res, 500, { error: 'internal error' }, CORS);
    });
  });
  server.keepAliveTimeout = 65_000;
  server.requestTimeout = 30_000;

  const app: App = {
    server,
    db,
    health,
    async close() {
      clearInterval(lagTimer);
      clearInterval(retentionTimer);
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await closed;
      try { db.close(); } catch { /* ignore */ }
    },
  };
  return app;
}
