import path from 'node:path';
import { createApp } from './app';
import { log } from './log';

/** A single collector process. Normally started by the supervisor (main.ts), which restarts it on failure. */
export function startWorker() {
  const root = process.env.JOURNEY_ROOT || path.resolve(__dirname, '..');
  const port = Number(process.env.PORT || 4400);
  const app = createApp({
    dbFile: process.env.JOURNEY_DB || path.join(root, 'data', 'journey.db'),
    staticDir: process.env.JOURNEY_STATIC || path.join(root, 'dist', 'public'),
    demoDir: process.env.JOURNEY_DEMO || path.join(root, 'demo'),
    ingestKey: process.env.JOURNEY_INGEST_KEY || undefined,
    adminToken: process.env.JOURNEY_ADMIN_TOKEN || undefined,
    retentionDays: Number(process.env.JOURNEY_RETENTION_DAYS || 30),
  });

  app.server.listen(port, () => {
    log.info('collector listening', { port });
    process.send?.({ type: 'ready', port });
  });

  let stopping = false;
  const shutdown = async (code: number) => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(code), 10_000);
    force.unref();
    try { await app.close(); } catch { /* ignore */ }
    process.exit(code);
  };
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  process.on('message', (m: any) => { if (m?.type === 'shutdown') shutdown(0); });
  // Crash fast on unknown state; the supervisor restarts a clean process.
  process.on('uncaughtException', (e) => {
    log.error('uncaught exception, exiting for restart', { err: String(e?.stack || e) });
    shutdown(1);
  });
  process.on('unhandledRejection', (e) => {
    log.error('unhandled rejection, exiting for restart', { err: String((e as Error)?.stack || e) });
    shutdown(1);
  });
  return app;
}
