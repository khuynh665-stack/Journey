import { Supervisor } from './supervisor';
import { startWorker } from './worker';

/**
 * Entry point.
 *   node dist/server.js           -> supervisor that runs and heals a worker process
 *   node dist/server.js --worker  -> the collector itself (used by the supervisor)
 *   JOURNEY_NO_SUPERVISOR=1       -> run the worker directly (e.g. under systemd/k8s which already restart)
 */
if (process.argv.includes('--worker') || process.env.JOURNEY_NO_SUPERVISOR === '1') {
  startWorker();
} else {
  const sup = new Supervisor({ script: __filename, args: ['--worker'], port: Number(process.env.PORT || 4400) });
  sup.start();
  const stop = () => sup.stop().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
