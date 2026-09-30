import React from 'react';
import { useApi } from '../hooks';
import { fmtDuration } from '../api';
import { Empty, ErrorBox, Loading, Stat } from '../components/ui';

interface OverviewData {
  totals: { sessions: number; visitors: number; avg_duration_ms: number; pageviews: number; sessions_with_errors: number; sessions_with_struggle: number };
  topPages: { path: string; views: number; sessions: number }[];
  topErrors: { message: string; occurrences: number; sessions: number; sample_session: string }[];
  struggles: { kind: string; target: string; occurrences: number; sessions: number; sample_session: string }[];
  daily: { day: string; sessions: number }[];
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '0%');

export function Overview() {
  const { data, error, loading, reload } = useApi<OverviewData>('/api/overview');
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading />;
  const t = data.totals;
  const maxDay = Math.max(1, ...data.daily.map((d) => d.sessions));
  return (
    <div className="stack">
      <div className="page-head">
        <h1>Overview</h1>
        <button className="ghost" onClick={reload} disabled={loading}>Refresh</button>
      </div>
      {t.sessions === 0 && (
        <div className="card">
          <h3>No sessions yet</h3>
          <p>Add the capture snippet to a site, or open the <a href="/demo/" target="_blank" rel="noreferrer">demo shop</a> and click around to create one.</p>
          <pre className="code">{`<script src="${location.origin}/journey.js" async></script>`}</pre>
        </div>
      )}
      <div className="stats">
        <Stat label="Sessions" value={t.sessions.toLocaleString()} />
        <Stat label="Visitors" value={t.visitors.toLocaleString()} />
        <Stat label="Avg. duration" value={fmtDuration(t.avg_duration_ms)} />
        <Stat label="Page views" value={t.pageviews.toLocaleString()} />
        <Stat label="With errors" value={pct(t.sessions_with_errors, t.sessions)} hint={`${t.sessions_with_errors} sessions`} />
        <Stat label="With struggle" value={pct(t.sessions_with_struggle, t.sessions)} hint="rage or dead clicks" />
      </div>
      {data.daily.length > 0 && (
        <div className="card">
          <h3>Sessions per day</h3>
          <div className="bars" role="img" aria-label="Sessions per day">
            {data.daily.map((d) => (
              <div key={d.day} className="bar-col" title={`${d.day}: ${d.sessions}`}>
                <div className="bar" style={{ height: `${(d.sessions / maxDay) * 100}%` }} />
                <span>{d.day.slice(5)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="grid2">
        <div className="card">
          <h3>Top pages</h3>
          {data.topPages.length ? (
            <table>
              <thead><tr><th>Page</th><th className="num">Views</th><th className="num">Sessions</th></tr></thead>
              <tbody>
                {data.topPages.map((p) => (
                  <tr key={p.path}><td><a href={`#/sessions?url=${encodeURIComponent(p.path)}`}>{p.path}</a></td><td className="num">{p.views}</td><td className="num">{p.sessions}</td></tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>No page views yet.</Empty>}
        </div>
        <div className="card">
          <h3>Struggle hotspots</h3>
          {data.struggles.length ? (
            <table>
              <thead><tr><th>Signal</th><th>Element</th><th className="num">Count</th><th /></tr></thead>
              <tbody>
                {data.struggles.map((s) => (
                  <tr key={s.kind + s.target}>
                    <td><span className={`badge badge-${s.kind === 'rage_click' ? 'rage' : 'dead'}`}>{s.kind === 'rage_click' ? 'Rage click' : 'Dead click'}</span></td>
                    <td className="mono clip" title={s.target}>{s.target || '—'}</td>
                    <td className="num">{s.occurrences}</td>
                    <td><a href={`#/sessions/${s.sample_session}`}>Replay</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty>No rage or dead clicks detected.</Empty>}
        </div>
      </div>
      <div className="card">
        <h3>Top JavaScript errors</h3>
        {data.topErrors.length ? (
          <table>
            <thead><tr><th>Message</th><th className="num">Occurrences</th><th className="num">Sessions</th><th /></tr></thead>
            <tbody>
              {data.topErrors.map((e) => (
                <tr key={e.message}><td className="mono clip" title={e.message}>{e.message}</td><td className="num">{e.occurrences}</td><td className="num">{e.sessions}</td><td><a href={`#/sessions/${e.sample_session}`}>Replay</a></td></tr>
              ))}
            </tbody>
          </table>
        ) : <Empty>No errors captured.</Empty>}
      </div>
    </div>
  );
}
