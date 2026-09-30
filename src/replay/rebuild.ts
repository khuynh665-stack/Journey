import type { JourneyEvent, MutationPayload, NodeId, SerializedNode } from '../shared/types';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface ReplayHooks {
  onViewport?(w: number, h: number): void;
  onPointer?(x: number, y: number, click: boolean): void;
  onUrl?(url: string): void;
  onWarning?(msg: string): void;
}

/**
 * Rebuilds a recorded page inside a document (normally a sandboxed iframe with scripts disabled).
 * Every operation is defensive: a missing node or bad attribute is reported and skipped, never thrown,
 * so one damaged event cannot break the rest of a replay.
 */
export class Rebuilder {
  private nodes = new Map<NodeId, Node>();
  private ids = new WeakMap<Node, NodeId>();
  warnings = 0;

  constructor(private doc: Document, private hooks: ReplayHooks = {}) {}

  private warn(msg: string): void {
    this.warnings++;
    this.hooks.onWarning?.(msg);
  }

  node(id: NodeId): Node | undefined {
    return this.nodes.get(id);
  }

  private build(s: SerializedNode, svg = false): Node | null {
    const doc = this.doc;
    let n: Node;
    switch (s.t) {
      case 'txt':
        n = doc.createTextNode(s.v);
        break;
      case 'cmt':
        n = doc.createComment(s.v);
        break;
      case 'dt':
        try { n = doc.implementation.createDocumentType(s.name || 'html', '', ''); } catch { return null; }
        break;
      case 'el': {
        const isSvg = svg || !!s.svg || s.tag === 'svg';
        let el: Element;
        try {
          el = isSvg ? doc.createElementNS(SVG_NS, s.tag) : doc.createElement(s.tag);
        } catch {
          this.warn(`bad tag ${s.tag}`);
          el = doc.createElement('div');
        }
        for (const [k, v] of Object.entries(s.a)) this.setAttr(el, k, v);
        if (s.tag === 'a' || s.tag === 'form') el.setAttribute('target', '_blank');
        for (const c of s.c) {
          const child = this.build(c, isSvg && s.tag !== 'foreignObject');
          if (child) el.appendChild(child);
        }
        if (s.tag === 'input' && 'value' in s.a) (el as HTMLInputElement).value = s.a.value;
        if (s.tag === 'textarea' && 'value' in s.a) (el as HTMLTextAreaElement).value = s.a.value;
        n = el;
        break;
      }
      case 'doc':
        this.warn('nested document');
        return null;
    }
    this.nodes.set(s.id, n);
    this.ids.set(n, s.id);
    return n;
  }

  private setAttr(el: Element, k: string, v: string | null): void {
    try {
      if (v === null) {
        el.removeAttribute(k);
        return;
      }
      if (/^on/i.test(k)) return;
      if ((k === 'href' || k === 'src' || k === 'action') && /^\s*javascript:/i.test(v)) return;
      el.setAttribute(k, v);
      if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = v;
      if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = true;
    } catch {
      this.warn(`bad attribute ${k}`);
    }
  }

  snapshot(root: SerializedNode): void {
    this.nodes.clear();
    const doc = this.doc;
    while (doc.firstChild) doc.removeChild(doc.firstChild);
    if (root.t !== 'doc') {
      this.warn('snapshot root is not a document');
      return;
    }
    this.nodes.set(root.id, doc);
    for (const c of root.c) {
      const n = this.build(c);
      if (!n) continue;
      try { doc.appendChild(n); } catch { this.warn('could not append root child'); }
    }
    // Ensure replayed pages never navigate the dashboard or run code.
    const head = doc.head || doc.querySelector('head');
    if (head) {
      const base = doc.createElement('base');
      base.setAttribute('target', '_blank');
      head.insertBefore(base, head.firstChild);
    }
  }

  mutate(m: MutationPayload): void {
    for (const r of m.removes) {
      const n = this.nodes.get(r.id);
      if (!n) { this.warn(`remove: unknown node ${r.id}`); continue; }
      n.parentNode?.removeChild(n);
      this.forget(n);
    }
    for (const a of m.adds) {
      const parent = this.nodes.get(a.parent);
      if (!parent) { this.warn(`add: unknown parent ${a.parent}`); continue; }
      const isSvg = (parent as Element).namespaceURI === SVG_NS && (parent as Element).tagName !== 'foreignObject';
      const n = this.build(a.node, isSvg);
      if (!n) continue;
      const next = a.next !== null ? this.nodes.get(a.next) : null;
      try {
        parent.insertBefore(n, next && next.parentNode === parent ? next : null);
      } catch {
        this.warn('add: insert failed');
      }
    }
    for (const at of m.attrs) {
      const el = this.nodes.get(at.id) as Element | undefined;
      if (!el || el.nodeType !== 1) { this.warn(`attr: unknown node ${at.id}`); continue; }
      for (const [k, v] of Object.entries(at.a)) this.setAttr(el, k, v);
    }
    for (const t of m.texts) {
      const n = this.nodes.get(t.id);
      if (!n) { this.warn(`text: unknown node ${t.id}`); continue; }
      n.textContent = t.v;
    }
  }

  private forget(n: Node): void {
    const id = this.ids.get(n);
    if (id !== undefined) this.nodes.delete(id);
    n.childNodes.forEach((c) => this.forget(c));
  }

  apply(e: JourneyEvent, live = true): void {
    switch (e.type) {
      case 'meta':
        this.hooks.onViewport?.(e.w, e.h);
        this.hooks.onUrl?.(e.url);
        break;
      case 'resize':
        this.hooks.onViewport?.(e.w, e.h);
        break;
      case 'snapshot':
        this.snapshot(e.node);
        this.scrollWindow(e.sx, e.sy);
        break;
      case 'mutation':
        this.mutate(e.m);
        break;
      case 'input': {
        const el = e.id !== null ? (this.nodes.get(e.id) as HTMLInputElement | undefined) : undefined;
        if (!el) break;
        const type = (el.getAttribute?.('type') || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') el.checked = e.v === 'true';
        else if ('value' in el) el.value = e.v;
        break;
      }
      case 'scroll':
        if (e.id === null) this.scrollWindow(e.x, e.y);
        else {
          const el = this.nodes.get(e.id) as Element | undefined;
          if (el && 'scrollTop' in el) { el.scrollTop = e.y; el.scrollLeft = e.x; }
        }
        break;
      case 'move':
        if (live) this.hooks.onPointer?.(e.x, e.y, false);
        break;
      case 'click':
        if (live) this.hooks.onPointer?.(e.x, e.y, true);
        break;
      case 'nav':
        this.hooks.onUrl?.(e.url);
        break;
    }
  }

  private scrollWindow(x: number, y: number): void {
    try { this.doc.defaultView?.scrollTo(x, y); } catch { /* jsdom / detached */ }
  }
}

/** Timeline controller: seeking re-applies from the nearest snapshot, playback advances by wall clock × speed. */
export class Player {
  readonly events: JourneyEvent[];
  readonly start: number;
  readonly end: number;
  private cursor = 0;          // index of the next event to apply
  private time = 0;            // ms offset from start
  speed = 1;
  skipInactive = true;

  constructor(events: JourneyEvent[], private rebuilder: Rebuilder) {
    this.events = [...events].sort((a, b) => a.ts - b.ts);
    // The timeline begins at the first snapshot: before it there is nothing to show.
    this.start = this.events.find((e) => e.type === 'snapshot')?.ts ?? this.events[0]?.ts ?? 0;
    this.end = this.events[this.events.length - 1]?.ts ?? 0;
  }

  get duration(): number {
    return this.end - this.start;
  }
  get currentTime(): number {
    return this.time;
  }
  get finished(): boolean {
    return this.cursor >= this.events.length;
  }

  seek(offset: number): void {
    const target = this.start + Math.max(0, Math.min(offset, this.duration));
    let snap = -1;
    for (let i = 0; i < this.events.length && this.events[i].ts <= target; i++) {
      if (this.events[i].type === 'snapshot') snap = i;
    }
    // meta events before the snapshot still matter (viewport size, url)
    for (let i = 0; i < Math.max(snap, 0); i++) {
      const e = this.events[i];
      if (e.type === 'meta' || e.type === 'resize' || e.type === 'nav') this.rebuilder.apply(e, false);
    }
    this.cursor = Math.max(snap, 0);
    this.time = target - this.start;
    this.applyUntil(target, false);
  }

  /** Advance playback by `dt` wall-clock ms. Returns false when the end is reached. */
  tick(dt: number): boolean {
    let next = this.start + this.time + dt * this.speed;
    const upcoming = this.events[this.cursor];
    if (this.skipInactive && upcoming && upcoming.ts - (this.start + this.time) > 5000) {
      next = Math.max(next, upcoming.ts - 1000); // jump over idle periods
    }
    this.time = Math.min(next, this.end) - this.start;
    this.applyUntil(this.start + this.time, true);
    return !this.finished;
  }

  private applyUntil(ts: number, live: boolean): void {
    while (this.cursor < this.events.length && this.events[this.cursor].ts <= ts) {
      try {
        this.rebuilder.apply(this.events[this.cursor], live);
      } catch {
        /* keep playing past a broken event */
      }
      this.cursor++;
    }
  }
}
