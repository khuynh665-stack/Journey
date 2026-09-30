/** Event model shared by the capture SDK, the collector and the dashboard. */

export type NodeId = number;

export type SerializedNode =
  | { id: NodeId; t: 'doc'; c: SerializedNode[] }
  | { id: NodeId; t: 'dt'; name: string }
  | { id: NodeId; t: 'el'; tag: string; a: Record<string, string>; c: SerializedNode[]; svg?: boolean }
  | { id: NodeId; t: 'txt'; v: string }
  | { id: NodeId; t: 'cmt'; v: string };

export interface MutationPayload {
  adds: { parent: NodeId; next: NodeId | null; node: SerializedNode }[];
  removes: { parent: NodeId; id: NodeId }[];
  attrs: { id: NodeId; a: Record<string, string | null> }[];
  texts: { id: NodeId; v: string }[];
}

export type JourneyEvent =
  | { type: 'meta'; ts: number; url: string; title: string; w: number; h: number; ua: string; ref: string }
  | { type: 'snapshot'; ts: number; node: SerializedNode; sx: number; sy: number }
  | { type: 'mutation'; ts: number; m: MutationPayload }
  | { type: 'nav'; ts: number; url: string; title: string; kind: 'load' | 'push' | 'replace' | 'pop' | 'hash' }
  | { type: 'click'; ts: number; id: NodeId | null; sel: string; text: string; x: number; y: number }
  | { type: 'input'; ts: number; id: NodeId | null; sel: string; v: string; masked: boolean }
  | { type: 'scroll'; ts: number; id: NodeId | null; x: number; y: number }
  | { type: 'move'; ts: number; x: number; y: number }
  | { type: 'resize'; ts: number; w: number; h: number }
  | { type: 'error'; ts: number; msg: string; src: string; stack: string }
  | { type: 'custom'; ts: number; name: string; data: Record<string, unknown> }
  | { type: 'visibility'; ts: number; hidden: boolean };

export type EventType = JourneyEvent['type'];

export interface IngestBatch {
  sid: string;           // session id
  vid: string;           // visitor id (persists across sessions)
  seq: number;           // monotonically increasing batch number within a session, used for de-duplication
  events: JourneyEvent[];
  sdk: string;           // SDK version
}

export interface SessionSummary {
  id: string;
  visitor_id: string;
  started_at: number;
  last_seen_at: number;
  duration_ms: number;
  entry_url: string;
  exit_url: string;
  page_count: number;
  event_count: number;
  click_count: number;
  error_count: number;
  rage_clicks: number;
  dead_clicks: number;
  user_agent: string;
  user_id: string | null;
}
