import React, { useMemo, useState } from 'react';
import { useApi } from '../hooks';
import { Empty, ErrorBox, Loading } from '../components/ui';

interface Graph {
  nodes: { id: string; step: number; path: string; sessions: number }[];
  links: { source: string; target: string; sessions: number }[];
  topPaths: { path: string[]; sessions: number }[];
  transitions: { from: string; to: string; sessions: number }[];
}

const COL_W = 180, NODE_W = 12, GAP = 14, H = 460, MAX_PX_PER_SESSION = 36;

/** Minimal Sankey layout: one column per step, node height proportional to sessions. */
function layout(g: Graph) {
  const steps = Math.max(0, ...g.nodes.map((n) => n.step)) + 1;
  const cols = Array.from({ length: steps }, (_, i) => g.nodes.filter((n) => n.step === i).sort((a, b) => (a.path === '(exit)' ? 1 : b.path === '(exit)' ? -1 : b.sessions - a.sessions)));
  // Fit the tallest column (its sessions plus the gaps between its nodes) into the canvas.
  // Small datasets are capped so a single session does not fill the whole chart.
  const scale = Math.min(MAX_PX_PER_SESSION, ...cols.map((c) => (H - 20 - GAP * (c.length - 1)) / Math.max(1, c.reduce((s, n) => s + n.sessions, 0))));
  const pos = new Map<string, { x: number; y: number; h: number; outY: number; inY: number }>();
  cols.forEach((c, i) => {
    let y = 10;
    for (const n of c) {
      const h = Math.max(2, n.sessions * scale);
      pos.set(n.id, { x: 10 + i * COL_W, y, h, outY: y, inY: y });
      y += h + GAP;
    }
  });
  const links = [...g.links].sort((a, b) => b.sessions - a.sessions).map((l) => {
    const s = pos.get(l.source)!, t = pos.get(l.target)!;
    const w = Math.max(1, l.sessions * scale);
    const y0 = s.outY + w / 2, y1 = t.inY + w / 2;
    s.outY += w;
    t.inY += w;
    const x0 = s.x + NODE_W, x1 = t.x, mx = (x0 + x1) / 2;
    return { ...l, d: `M${x0},${y0} C${mx},${y0} ${mx},${y1} ${x1},${y1}`, w };
  });
  return { pos, links, width: steps * COL_W + 40 };
}

export function Journeys() {
  const [start, setStart] = useState('');
  const [applied, setApplied] = useState('');
  const { data, error, reload } = useApi<Graph>(`/api/journeys?depth=5&width=6${applied ? `&start=${encodeURIComponent(applied)}` : ''}`);
  const lay = useMemo(() => (data && data.nodes.length ? layout(data) : null), [data]);
  const [hover, setHover] = useState<string | null>(null);

  return (
    <div className="stack">
      <div className="page-head"><h1>Journeys</h1></div>
      <form className="filters card" onSubmit={(e) => { e.preventDefault(); setApplied(start.trim()); }}>
        <input aria-label="Start page" placeholder="Start from page, e.g. /product/1 (blank = entry pages)" value={start} onChange={(e) => setStart(e.target.value)} />
        <button type="submit">Show paths</button>
      </form>
      {error && <ErrorBox error={error} onRetry={reload} />}
      {!data && !error && <Loading />}
      {data && !lay && <Empty>No journeys yet.</Empty>}
      {data && lay && (
        <>
          <div className="card">
            <h3>Page flow</h3>
            <p className="muted small">Each column is a step in the visit. Band width is the number of sessions. Hover a band for details.</p>
            <div className="scroll-x">
              <svg width={lay.width} height={H} className="sankey">
                {lay.links.map((l) => (
                  <path key={l.source + l.target} d={l.d} strokeWidth={l.w} className={`link ${l.target.endsWith('(exit)') ? 'exit' : ''} ${hover && hover !== l.source && hover !== l.target ? 'dim' : ''}`}>
                    <title>{`${l.source.split(':').slice(1).join(':')} → ${l.target.split(':').slice(1).join(':')}: ${l.sessions} sessions`}</title>
                  </path>
                ))}
                {data.nodes.map((n) => {
                  const p = lay.pos.get(n.id)!;
                  return (
                    <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
                      <rect x={p.x} y={p.y} width={NODE_W} height={p.h} className={`node ${n.path === '(exit)' ? 'exit' : ''}`} rx={2} />
                      <text x={p.x + NODE_W + 4} y={p.y + Math.min(p.h / 2, 14) + 4} className="node-label">{n.path.length > 22 ? n.path.slice(0, 21) + '…' : n.path} ({n.sessions})</text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
          <div className="grid2">
            <div className="card">
              <h3>Most common paths</h3>
              <table>
                <thead><tr><th>Path</th><th className="num">Sessions</th></tr></thead>
                <tbody>{data.topPaths.map((p) => <tr key={p.path.join('>')}><td className="small">{p.path.join(' → ')}</td><td className="num">{p.sessions}</td></tr>)}</tbody>
              </table>
            </div>
            <div className="card">
              <h3>Top transitions</h3>
              <table>
                <thead><tr><th>From</th><th>To</th><th className="num">Sessions</th></tr></thead>
                <tbody>{data.transitions.slice(0, 15).map((t) => <tr key={t.from + t.to}><td className="small">{t.from}</td><td className="small">{t.to}</td><td className="num">{t.sessions}</td></tr>)}</tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
