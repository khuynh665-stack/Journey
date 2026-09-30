/** Dashboard API client. Retries transient failures (network, 5xx) with backoff so a collector restart is invisible. */
export async function api<T>(path: string, attempts = 4): Promise<T> {
  let lastErr: unknown;
  const token = new URLSearchParams(location.search).get('token') || localStorageGet('journey:token');
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (res.ok) return (await res.json()) as T;
      if (res.status < 500) {
        const body = await res.json().catch(() => ({}));
        throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { fatal: true });
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e: any) {
      if (e?.fatal) throw e;
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 300 * 2 ** i));
  }
  throw lastErr;
}

function localStorageGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.pathname + x.search + x.hash;
  } catch {
    return u;
  }
}

export function browserOf(ua: string): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return ua ? 'Other' : '—';
}
