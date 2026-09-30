import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { JourneyEvent, SessionSummary } from '../../shared/types';
import { Player, Rebuilder } from '../../replay/rebuild';
import { useApi } from '../hooks';
import { browserOf, fmtClock, fmtDuration, shortUrl } from '../api';
import { Badge, ErrorBox, Loading } from '../components/ui';

interface SessionDetail {
  session: SessionSummary;
  events: JourneyEvent[];
  pages: { ts: number; url: string; title: string }[];
  signals: { ts: number; kind: string; detail: string }[];
  corrupt: number;
}

type Row = { ts: number; kind: string; label: string; detail?: string; seekTs?: number };

/**
 * A navigation event fires before the new page renders. Jumping to it would show the previous page,
 * so seek to the first DOM change after it instead (bounded so we never land on the following page).
 */
function settleAfterNav(events: JourneyEvent[], i: number): number {
  const nav = events[i];
  for (let j = i + 1; j < events.length; j++) {
    const e = events[j];
    if (e.type === 'nav' || e.ts - nav.ts > 2000) break;
    if (e.type === 'mutation' || e.type === 'snapshot') return e.ts;
  }
  return nav.ts;
}

function activity(d: SessionDetail): Row[] {
  const rows: Row[] = [];
  d.events.forEach((e, i) => {
    if (e.type === 'nav') rows.push({ ts: e.ts, kind: 'nav', label: 'Page', detail: shortUrl(e.url), seekTs: settleAfterNav(d.events, i) });
    else if (e.type === 'click') rows.push({ ts: e.ts, kind: 'click', label: 'Click', detail: e.text || e.sel });
    else if (e.type === 'input') rows.push({ ts: e.ts, kind: 'input', label: 'Input', detail: `${e.sel} = ${e.v}` });
    else if (e.type === 'error') rows.push({ ts: e.ts, kind: 'error', label: 'Error', detail: e.msg });
    else if (e.type === 'custom' && e.name !== 'sdk_error') rows.push({ ts: e.ts, kind: 'custom', label: e.name, detail: JSON.stringify(e.data) });
  });
  for (const s of d.signals) if (s.kind !== 'error') rows.push({ ts: s.ts, kind: s.kind, label: s.kind === 'rage_click' ? 'Rage click' : 'Dead click', detail: s.detail });
  // Collapse bursts of inputs on the same field so the list stays readable.
  const out: Row[] = [];
  for (const r of rows.sort((a, b) => a.ts - b.ts)) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'input' && r.kind === 'input' && prev.detail?.split(' = ')[0] === r.detail?.split(' = ')[0]) out[out.length - 1] = r;
    else out.push(r);
  }
  return out;
}

export function Replay({ id, startAt }: { id: string; startAt: number }) {
  const { data, error, reload } = useApi<SessionDetail>(`/api/sessions/${id}`);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Loading what="Loading session" />;
  return <ReplayView data={data} startAt={startAt} />;
}

function ReplayView({ data, startAt }: { data: SessionDetail; startAt: number }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const player = useRef<Player | null>(null);
  const [viewport, setViewport] = useState({ w: 1280, h: 800 });
  const [scale, setScale] = useState(1);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [skip, setSkip] = useState(true);
  const [url, setUrl] = useState('');
  const [warnings, setWarnings] = useState(0);
  const rows = useMemo(() => activity(data), [data]);
  const s = data.session;
  const hasSnapshot = data.events.some((e) => e.type === 'snapshot');

  // Build the player once the iframe document exists.
  useEffect(() => {
    const doc = frame.current?.contentDocument;
    if (!doc) return;
    const rebuilder = new Rebuilder(doc, {
      onViewport: (w, h) => setViewport({ w, h }),
      onUrl: setUrl,
      onWarning: () => setWarnings((n) => n + 1),
      onPointer: (x, y, click) => {
        const c = cursor.current;
        if (!c) return;
        c.style.transform = `translate(${x}px, ${y}px)`;
        c.classList.add('seen');
        if (click) {
          c.classList.remove('clicked');
          void c.offsetWidth; // restart the animation
          c.classList.add('clicked');
        }
      },
    });
    const p = new Player(data.events, rebuilder);
    player.current = p;
    p.seek(startAt);
    setTime(p.currentTime);
  }, [data, startAt]);

  // Fit the recorded viewport into the stage.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / viewport.w, (window.innerHeight * 0.68) / viewport.h));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewport]);

  // Playback loop.
  useEffect(() => {
    const p = player.current;
    if (!playing || !p) return;
    p.speed = speed;
    p.skipInactive = skip;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const more = p.tick(now - last);
      last = now;
      setTime(p.currentTime);
      if (more) raf = requestAnimationFrame(loop);
      else setPlaying(false);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, skip]);

  const seek = (offset: number) => {
    const p = player.current;
    if (!p) return;
    p.seek(offset);
    setTime(p.currentTime);
  };
  const duration = player.current?.duration ?? s.duration_ms;
  const start = player.current?.start ?? s.started_at;
  const pos = (ts: number) => `${duration ? ((ts - start) / duration) * 100 : 0}%`;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <a href="#/sessions" className="muted">← Sessions</a>
          <h1>Session replay</h1>
          <div className="muted small">
            {new Date(s.started_at).toLocaleString()} · {fmtDuration(s.duration_ms)} · {s.page_count} pages · {browserOf(s.user_agent)} · <span className="mono">{s.user_id || s.visitor_id}</span>
          </div>
        </div>
        <div className="signals">
          {s.error_count > 0 && <Badge kind="error">{s.error_count} errors</Badge>}
          {s.rage_clicks > 0 && <Badge kind="rage">{s.rage_clicks} rage clicks</Badge>}
          {s.dead_clicks > 0 && <Badge kind="dead">{s.dead_clicks} dead clicks</Badge>}
        </div>
      </div>
      <div className="replay">
        <div className="card flush replay-main">
          <div className="urlbar mono clip">{url || s.entry_url}</div>
          <div className="stage" ref={stage} style={{ height: viewport.h * scale }}>
            {!hasSnapshot && <div className="empty">This session has no page snapshot yet, so only the activity list is available.</div>}
            <div className="viewport" style={{ width: viewport.w, height: viewport.h, transform: `scale(${scale})` }}>
              <iframe ref={frame} title="Session replay" sandbox="allow-same-origin" style={{ width: viewport.w, height: viewport.h }} />
              <div className="cursor" ref={cursor} />
            </div>
          </div>
          <div className="controls">
            <button onClick={() => { if (player.current?.finished) seek(0); setPlaying(!playing); }} aria-label={playing ? 'Pause' : 'Play'}>{playing ? 'Pause' : 'Play'}</button>
            <span className="mono small">{fmtClock(time)} / {fmtClock(duration)}</span>
            <div className="timeline" onClick={(e) => {
              const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              seek(((e.clientX - r.left) / r.width) * duration);
            }}>
              <div className="progress" style={{ width: pos(start + time) }} />
              {data.pages.map((p) => <span key={`n${p.ts}`} className="mark mark-nav" style={{ left: pos(p.ts) }} title={shortUrl(p.url)} />)}
              {data.signals.map((g, i) => <span key={`s${i}`} className={`mark mark-${g.kind}`} style={{ left: pos(g.ts) }} title={`${g.kind}: ${g.detail}`} />)}
            </div>
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-label="Speed">
              {[1, 2, 4, 8].map((x) => <option key={x} value={x}>{x}×</option>)}
            </select>
            <label className="check small"><input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} /> Skip idle</label>
          </div>
          {(warnings > 0 || data.corrupt > 0) && (
            <div className="muted small pad">Replay recovered from {warnings + data.corrupt} damaged or missing steps; the page may differ slightly from what the visitor saw.</div>
          )}
        </div>
        <div className="card flush activity">
          <h3 className="pad">Activity</h3>
          <ol>
            {rows.map((r, i) => (
              <li key={i} className={`act act-${r.kind} ${r.ts - start <= time ? 'past' : ''}`} onClick={() => seek((r.seekTs ?? r.ts) - start)}>
                <span className="mono small muted">{fmtClock(r.ts - start)}</span>
                <span className="act-label">{r.label}</span>
                <span className="clip small" title={r.detail}>{r.detail}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
