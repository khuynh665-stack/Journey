import React, { useState } from 'react';
import type { SessionSummary } from '../../shared/types';
import { go, useApi } from '../hooks';
import { browserOf, fmtDuration, shortUrl } from '../api';
import { Badge, Empty, ErrorBox, Loading } from '../components/ui';

const PAGE = 25;

export function Sessions({ params }: { params: URLSearchParams }) {
  const [q, setQ] = useState(params.get('q') || '');
  const [url, setUrl] = useState(params.get('url') || '');
  const hasError = params.get('hasError') === '1';
  const struggle = params.get('struggle') === '1';
  const offset = Number(params.get('offset') || 0);
  const qs = new URLSearchParams(params);
  qs.set('limit', String(PAGE));
  const { data, error, loading, reload } = useApi<{ total: number; sessions: SessionSummary[] }>(`/api/sessions?${qs}`);

  const update = (patch: Record<string, string | undefined>) => {
    const next: Record<string, string | undefined> = { q, url, hasError: hasError ? '1' : undefined, struggle: struggle ? '1' : undefined, ...patch };
    if (!('offset' in patch)) next.offset = undefined;
    go('/sessions', next);
  };

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Sessions</h1>
        <button className="ghost" onClick={reload} disabled={loading}>Refresh</button>
      </div>
      <form className="filters card" onSubmit={(e) => { e.preventDefault(); update({}); }}>
        <input aria-label="Search" placeholder="Session, visitor or user id, or URL" value={q} onChange={(e) => setQ(e.target.value)} />
        <input aria-label="Visited page" placeholder="Visited page contains…" value={url} onChange={(e) => setUrl(e.target.value)} />
        <label className="check"><input type="checkbox" checked={hasError} onChange={(e) => update({ hasError: e.target.checked ? '1' : undefined })} /> Errors</label>
        <label className="check"><input type="checkbox" checked={struggle} onChange={(e) => update({ struggle: e.target.checked ? '1' : undefined })} /> Struggle</label>
        <button type="submit">Search</button>
      </form>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && (
        <div className="card flush">
          {data.sessions.length === 0 ? <Empty>No sessions match these filters.</Empty> : (
            <table className="sessions">
              <thead>
                <tr><th>Started</th><th>Visitor</th><th>Entry → exit</th><th className="num">Pages</th><th className="num">Duration</th><th>Signals</th><th>Browser</th></tr>
              </thead>
              <tbody>
                {data.sessions.map((s) => (
                  <tr key={s.id} className="clickable" onClick={() => go(`/sessions/${s.id}`)}>
                    <td>{new Date(s.started_at).toLocaleString()}</td>
                    <td className="mono clip">{s.user_id || s.visitor_id.slice(0, 8)}</td>
                    <td className="clip" title={`${s.entry_url} → ${s.exit_url}`}>{shortUrl(s.entry_url)} → {shortUrl(s.exit_url)}</td>
                    <td className="num">{s.page_count}</td>
                    <td className="num">{fmtDuration(s.duration_ms)}</td>
                    <td className="signals">
                      {s.error_count > 0 && <Badge kind="error">{s.error_count} error{s.error_count > 1 ? 's' : ''}</Badge>}
                      {s.rage_clicks > 0 && <Badge kind="rage">{s.rage_clicks} rage</Badge>}
                      {s.dead_clicks > 0 && <Badge kind="dead">{s.dead_clicks} dead</Badge>}
                    </td>
                    <td>{browserOf(s.user_agent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="pager">
            <span className="muted">{data.total.toLocaleString()} sessions</span>
            <button className="ghost" disabled={offset === 0} onClick={() => update({ offset: String(Math.max(0, offset - PAGE)) })}>Previous</button>
            <button className="ghost" disabled={offset + PAGE >= data.total} onClick={() => update({ offset: String(offset + PAGE) })}>Next</button>
          </div>
        </div>
      )}
    </div>
  );
}
