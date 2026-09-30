import type { MutationPayload, NodeId, SerializedNode } from '../shared/types';
import { inputValue, isBlocked, maskText, type PrivacyConfig } from './mask';

const SKIP_TAGS = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE']);
const URL_ATTRS = new Set(['src', 'href', 'poster', 'action']);
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Bidirectional map between live DOM nodes and the ids used in the recording. */
export class Mirror {
  private ids = new WeakMap<Node, NodeId>();
  private nodes = new Map<NodeId, Node>();
  private next = 1;

  getId(n: Node | null | undefined): NodeId | null {
    return n ? this.ids.get(n) ?? null : null;
  }
  has(n: Node): boolean {
    return this.ids.has(n);
  }
  getNode(id: NodeId): Node | undefined {
    return this.nodes.get(id);
  }
  add(n: Node): NodeId {
    const id = this.next++;
    this.ids.set(n, id);
    this.nodes.set(id, n);
    return id;
  }
  removeTree(n: Node): void {
    const id = this.ids.get(n);
    if (id !== undefined) {
      this.ids.delete(n);
      this.nodes.delete(id);
    }
    n.childNodes.forEach((c) => this.removeTree(c));
  }
  reset(): void {
    this.ids = new WeakMap();
    this.nodes.clear();
  }
  get size(): number {
    return this.nodes.size;
  }
}

function absolutize(value: string, doc: Document): string {
  if (!value || /^(data:|blob:|javascript:|#|mailto:|tel:)/i.test(value)) return value;
  try {
    return new URL(value, doc.baseURI).href;
  } catch {
    return value;
  }
}

function absolutizeSrcset(value: string, doc: Document): string {
  return value
    .split(',')
    .map((part) => {
      const [u, d] = part.trim().split(/\s+/, 2);
      return d ? `${absolutize(u, doc)} ${d}` : absolutize(u, doc);
    })
    .join(', ');
}

export function serializeAttr(el: Element, name: string, value: string, cfg: PrivacyConfig): string | null {
  const doc = el.ownerDocument;
  if (name.startsWith('on')) return null; // inline handlers never leave the page
  if (name === 'value' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return inputValue(el, value, cfg).v;
  if (URL_ATTRS.has(name)) return absolutize(value, doc);
  if (name === 'srcset') return absolutizeSrcset(value, doc);
  return value;
}

export function isSkippable(n: Node): boolean {
  return n.nodeType === 1 && SKIP_TAGS.has((n as Element).tagName);
}

export function serializeNode(n: Node, mirror: Mirror, cfg: PrivacyConfig): SerializedNode | null {
  if (isSkippable(n)) return null;
  switch (n.nodeType) {
    case 9: {
      const id = mirror.add(n);
      return { id, t: 'doc', c: serializeChildren(n, mirror, cfg) };
    }
    case 10: {
      return { id: mirror.add(n), t: 'dt', name: (n as DocumentType).name };
    }
    case 3: {
      const parent = n.parentElement;
      const raw = n.textContent || '';
      // style text is structural, not user content
      const v = parent && parent.tagName === 'STYLE' ? raw : maskText(raw, parent, cfg);
      return { id: mirror.add(n), t: 'txt', v };
    }
    case 8:
      return { id: mirror.add(n), t: 'cmt', v: '' };
    case 1: {
      const el = n as Element;
      const id = mirror.add(n);
      const tag = el.tagName.toLowerCase();
      const a: Record<string, string> = {};
      if (isBlocked(el, cfg)) {
        const r = el.getBoundingClientRect();
        a['data-journey-blocked'] = '1';
        a.style = `width:${Math.round(r.width)}px;height:${Math.round(r.height)}px;background:#ccc`;
        return { id, t: 'el', tag: tag === 'img' ? 'div' : tag, a, c: [] };
      }
      for (const attr of Array.from(el.attributes)) {
        const v = serializeAttr(el, attr.name, attr.value, cfg);
        if (v !== null) a[attr.name] = v;
      }
      // Live form state is not reflected in attributes; record it explicitly.
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const input = el as HTMLInputElement;
        const type = (el.getAttribute('type') || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') {
          if (input.checked) a.checked = '';
          else delete a.checked;
        } else if (tag !== 'select' && input.value) {
          a.value = inputValue(el, input.value, cfg).v;
        }
      }
      const out: SerializedNode = { id, t: 'el', tag, a, c: serializeChildren(el, mirror, cfg) };
      if (el.namespaceURI === SVG_NS) out.svg = true;
      return out;
    }
    default:
      return null;
  }
}

function serializeChildren(n: Node, mirror: Mirror, cfg: PrivacyConfig): SerializedNode[] {
  const out: SerializedNode[] = [];
  n.childNodes.forEach((c) => {
    const s = serializeNode(c, mirror, cfg);
    if (s) out.push(s);
  });
  return out;
}

function nextMirroredSibling(n: Node, mirror: Mirror): NodeId | null {
  let s = n.nextSibling;
  while (s) {
    const id = mirror.getId(s);
    if (id !== null) return id;
    s = s.nextSibling;
  }
  return null;
}

/** Convert a batch of MutationRecords into an incremental payload. */
export function processMutations(records: MutationRecord[], mirror: Mirror, cfg: PrivacyConfig): MutationPayload {
  const out: MutationPayload = { adds: [], removes: [], attrs: [], texts: [] };
  const added = new Set<Node>();
  const attrMap = new Map<NodeId, Record<string, string | null>>();
  const textMap = new Map<NodeId, string>();

  for (const r of records) {
    if (r.type === 'childList') {
      r.removedNodes.forEach((n) => {
        added.delete(n);
        const id = mirror.getId(n);
        const parent = mirror.getId(r.target);
        if (id !== null && parent !== null) out.removes.push({ parent, id });
        if (id !== null) mirror.removeTree(n);
      });
      r.addedNodes.forEach((n) => added.add(n));
    } else if (r.type === 'attributes') {
      const id = mirror.getId(r.target);
      if (id === null || !r.attributeName) continue;
      const el = r.target as Element;
      const raw = el.getAttribute(r.attributeName);
      const v = raw === null ? null : serializeAttr(el, r.attributeName, raw, cfg);
      if (raw !== null && v === null) continue;
      const entry = attrMap.get(id) || {};
      entry[r.attributeName] = v;
      attrMap.set(id, entry);
    } else if (r.type === 'characterData') {
      const id = mirror.getId(r.target);
      if (id === null) continue;
      const parent = r.target.parentElement;
      const raw = r.target.textContent || '';
      textMap.set(id, parent && parent.tagName === 'STYLE' ? raw : maskText(raw, parent, cfg));
    }
  }

  // Keep only the top-most added nodes that are still attached; their subtree is serialized whole.
  const roots = Array.from(added).filter((n) => {
    if (!n.isConnected || mirror.has(n)) return false;
    for (let p = n.parentNode; p; p = p.parentNode) if (added.has(p) && !mirror.has(p)) return false;
    return n.parentNode !== null && mirror.has(n.parentNode);
  });
  // Reverse document order so that each node's next sibling is already known to the replayer.
  roots.sort((a, b) => (a.compareDocumentPosition(b) & 4 /* FOLLOWING */ ? 1 : -1));
  for (const n of roots) {
    const parent = mirror.getId(n.parentNode)!;
    const next = nextMirroredSibling(n, mirror);
    const node = serializeNode(n, mirror, cfg);
    if (node) out.adds.push({ parent, next, node });
  }

  // Skip changes to nodes that were removed later in the same batch.
  attrMap.forEach((a, id) => { if (mirror.getNode(id)) out.attrs.push({ id, a }); });
  textMap.forEach((v, id) => { if (mirror.getNode(id)) out.texts.push({ id, v }); });
  return out;
}

export function isEmptyMutation(m: MutationPayload): boolean {
  return !m.adds.length && !m.removes.length && !m.attrs.length && !m.texts.length;
}
