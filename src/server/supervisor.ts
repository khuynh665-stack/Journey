import { fork, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { log } from './log';

export interface SupervisorOptions {
  script: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  port: number;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  unhealthyThreshold?: number;   // consecutive failed probes before a restart
  minBackoffMs?: number;
  maxBackoffMs?: number;
  stableAfterMs?: number;        // uptime after which the backoff resets
}

/**
 * Keeps one collector worker alive:
 *  - restarts it when it exits, with exponential backoff to avoid a hot crash loop
 *  - probes /readyz and kills + restarts a worker that stays unhealthy (hung event loop, dead DB)
 *  - forwards SIGTERM/SIGINT for graceful shutdown
 */
export class Supervisor {
  private child: ChildProcess | null = null;
  private restarts = 0;
  private backoff: number;
  private failures = 0;
  private startedAt = 0;
  private stopping = false;
  private probeTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  readonly events: { t: number; kind: string; detail?: string }[] = [];

  constructor(private o: SupervisorOptions) {
    this.backoff = o.minBackoffMs ?? 500;
  }

  get restartCount(): number {
    return this.restarts;
  }
  get pid(): number | undefined {
    return this.child?.pid;
  }

  private note(kind: string, detail?: string): void {
    this.events.push({ t: Date.now(), kind, detail });
    if (this.events.length > 100) this.events.shift();
  }

  start(): void {
    this.stopping = false;
    this.spawn();
    this.probeTimer = setInterval(() => this.probe(), this.o.healthIntervalMs ?? 10_000);
  }

  private spawn(): void {
    this.startedAt = Date.now();
    this.failures = 0;
    const child = fork(this.o.script, this.o.args ?? [], { env: { ...process.env, ...this.o.env, PORT: String(this.o.port) }, stdio: 'inherit' });
    this.child = child;
    this.note('spawn', String(child.pid));
    log.info('worker started', { pid: child.pid });
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.note('exit', `${code ?? signal}`);
      if (this.stopping) return;
      const uptime = Date.now() - this.startedAt;
      if (uptime > (this.o.stableAfterMs ?? 60_000)) this.backoff = this.o.minBackoffMs ?? 500;
      log.warn('worker exited, restarting', { code, signal, delay_ms: this.backoff });
      this.restartTimer = setTimeout(() => {
        this.restarts++;
        this.spawn();
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, this.o.maxBackoffMs ?? 30_000);
    });
  }

  private probe(): void {
    if (!this.child || this.stopping) return;
    // Give a new worker time to boot before judging it.
    if (Date.now() - this.startedAt < (this.o.healthIntervalMs ?? 10_000)) return;
    const req = http.get({ host: '127.0.0.1', port: this.o.port, path: '/readyz', timeout: this.o.healthTimeoutMs ?? 3000 }, (res) => {
      res.resume();
      if (res.statusCode === 200) this.failures = 0;
      else this.onProbeFail(`status ${res.statusCode}`);
    });
    req.on('timeout', () => { req.destroy(); this.onProbeFail('timeout'); });
    req.on('error', (e) => this.onProbeFail(e.message));
  }

  private onProbeFail(reason: string): void {
    this.failures++;
    this.note('probe_fail', reason);
    log.warn('health probe failed', { reason, consecutive: this.failures });
    if (this.failures >= (this.o.unhealthyThreshold ?? 3) && this.child) {
      log.error('worker unhealthy, killing for restart');
      this.note('kill', 'unhealthy');
      this.failures = 0;
      this.child.kill('SIGKILL');
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.probeTimer) clearInterval(this.probeTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { child.kill('SIGKILL'); }, 10_000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      child.kill('SIGTERM');
    });
  }
}
