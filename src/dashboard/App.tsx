import React, { Component, type ReactNode } from 'react';
import { useHashRoute } from './hooks';
import { Overview } from './pages/Overview';
import { Sessions } from './pages/Sessions';
import { Replay } from './pages/Replay';
import { Journeys } from './pages/Journeys';
import { Funnels } from './pages/Funnels';

/** Error boundary: a crash in one view shows a recoverable message instead of a blank dashboard. */
class Boundary extends Component<{ children: ReactNode; resetKey: string }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: Error) {
    return { error: e.message };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <div className="card error-card">
          <h3>This view hit a problem</h3>
          <p className="muted">{this.state.error}</p>
          <button onClick={() => this.setState({ error: null })}>Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}

const NAV = [
  ['/', 'Overview'],
  ['/sessions', 'Sessions'],
  ['/journeys', 'Journeys'],
  ['/funnels', 'Funnels'],
] as const;

export function App() {
  const [path, params] = useHashRoute();
  const replayMatch = path.match(/^\/sessions\/([\w-]+)$/);
  let view: ReactNode;
  if (replayMatch) view = <Replay id={replayMatch[1]} startAt={Number(params.get('t') || 0)} />;
  else if (path === '/sessions') view = <Sessions params={params} />;
  else if (path === '/journeys') view = <Journeys />;
  else if (path === '/funnels') view = <Funnels params={params} />;
  else view = <Overview />;
  const active = replayMatch ? '/sessions' : path;
  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="#/">
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden><path d="M3 18c4 0 4-12 9-12s5 12 9 12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
          Journey
        </a>
        <nav>
          {NAV.map(([href, label]) => (
            <a key={href} href={`#${href}`} className={active === href ? 'active' : ''}>{label}</a>
          ))}
        </nav>
      </header>
      <main>
        <Boundary resetKey={path}>{view}</Boundary>
      </main>
    </div>
  );
}
