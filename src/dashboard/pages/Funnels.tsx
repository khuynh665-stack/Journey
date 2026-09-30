import React, { useState } from 'react';
import { go, useApi } from '../hooks';
import { Empty, ErrorBox, Loading } from '../components/ui';

interface FunnelData {
  total: number;
  steps: { step: string; sessions: number; conversion: number; dropoff: number; dropSamples: string[] }[];
}

const DEFAULT_STEPS = '/demo, /demo/product/*, /demo/cart, /demo/checkout, /demo/thank-you';

export function Funnels({ params }: { params: URLSearchParams }) {
  const current = params.get('steps') || DEFAULT_STEPS.replace(/\s/g, '');
  const [text, setText] = useState(current.split(',').join(', '));
  const { data, error, loading, reload } = useApi<FunnelData>(`/api/funnel?steps=${encodeURIComponent(current)}`);

  return (
    <div className="stack">
      <div className="page-head"><h1>Funnels</h1></div>
      <form className="filters card" onSubmit={(e) => { e.preventDefault(); go('/funnels', { steps: text.split(',').map((s) => s.trim()).filter(Boolean).join(',') }); }}>
        <input aria-label="Funnel steps" value={text} onChange={(e) => setText(e.target.value)} placeholder="Comma-separated steps" />
        <button type="submit">Analyze</button>
      </form>
      <p className="muted small">Steps are page paths (use <code>*</code> as a wildcard) or custom events written as <code>event:name</code>. A session counts for a step only after it completed the steps before it, in order.</p>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && (data.total === 0 ? <Empty>No sessions reached the first step.</Empty> : (
        <div className="card">
          <div className="funnel">
            {data.steps.map((s, i) => (
              <div key={s.step} className="funnel-row">
                <div className="funnel-label">
                  <span className="funnel-idx">{i + 1}</span>
                  <span className="mono">{s.step}</span>
                </div>
                <div className="funnel-bar-wrap">
                  <div className="funnel-bar" style={{ width: `${Math.max(s.conversion * 100, 0.5)}%` }} />
                </div>
                <div className="funnel-nums">
                  <strong>{s.sessions}</strong> <span className="muted">({Math.round(s.conversion * 100)}%)</span>
                  {i > 0 && s.dropoff > 0 && <div className="small drop">−{Math.round(s.dropoff * 100)}% from previous</div>}
                </div>
                {i < data.steps.length - 1 && s.dropSamples.length > 0 && (
                  <div className="funnel-samples small">
                    Dropped after this step:{' '}
                    {s.dropSamples.slice(0, 5).map((id) => <a key={id} href={`#/sessions/${id}`} className="mono">{id.slice(0, 8)}</a>)}
                  </div>
                )}
              </div>
            ))}
          </div>
          {loading && <div className="muted small">Updating…</div>}
        </div>
      ))}
    </div>
  );
}
