import React, { type ReactNode } from 'react';

export function Loading({ what = 'Loading' }: { what?: string }) {
  return <div className="muted pad">{what}…</div>;
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="card error-card">
      <strong>Could not load data.</strong> <span className="muted">{error}</span>
      {onRetry && <button onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Badge({ kind, children }: { kind: 'error' | 'rage' | 'dead' | 'plain'; children: ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}
