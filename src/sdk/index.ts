import { Recorder, SDK_VERSION, type RecorderConfig } from './recorder';

export { Recorder, SDK_VERSION };
export type { RecorderConfig };

/**
 * Browser entry point. Usage:
 *   <script src="https://collector.example.com/journey.js" data-endpoint="https://collector.example.com/v1/ingest" async></script>
 * or set window.JourneyConfig = { endpoint: ... } before loading and call Journey.init().
 */
declare global {
  interface Window {
    Journey?: ReturnType<typeof createApi>;
    JourneyConfig?: RecorderConfig;
  }
}

function createApi() {
  let rec: Recorder | null = null;
  return {
    version: SDK_VERSION,
    init(cfg: RecorderConfig) {
      try {
        if (rec) rec.stop();
        rec = new Recorder(window, cfg);
        rec.start();
      } catch (e) {
        console.warn('[journey] failed to start', e);
      }
      return rec;
    },
    identify: (id: string, traits?: Record<string, unknown>) => rec?.identify(id, traits),
    track: (name: string, data?: Record<string, unknown>) => rec?.track(name, data),
    stop: () => rec?.stop(),
    get sessionId() { return rec?.sessionId; },
    get recorder() { return rec; },
  };
}

if (typeof window !== 'undefined' && !window.Journey) {
  const api = createApi();
  window.Journey = api;
  const script = document.currentScript as HTMLScriptElement | null;
  const endpoint = window.JourneyConfig?.endpoint || script?.dataset.endpoint
    || (script?.src ? new URL('/v1/ingest', script.src).href : undefined);
  if (endpoint && script?.dataset.autostart !== 'false') {
    const cfg: RecorderConfig = { ...window.JourneyConfig, endpoint };
    if (script?.dataset.key) cfg.ingestKey = script.dataset.key;
    if (script?.dataset.sampleRate) cfg.sampleRate = Number(script.dataset.sampleRate);
    const go = () => api.init(cfg);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true });
    else go();
  }
}
