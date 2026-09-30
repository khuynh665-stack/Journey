import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRIVACY } from '../src/sdk/mask';
import { Mirror, processMutations, serializeNode } from '../src/sdk/serializer';
import { Rebuilder } from '../src/replay/rebuild';
import type { SerializedNode } from '../src/shared/types';
import { dom, normalize } from './helpers';

const cfg = DEFAULT_PRIVACY;

function find(n: SerializedNode, pred: (n: SerializedNode) => boolean): SerializedNode | undefined {
  if (pred(n)) return n;
  if ('c' in n) for (const c of n.c) { const r = find(c, pred); if (r) return r; }
  return undefined;
}

test('snapshot drops scripts and inline handlers, absolutizes URLs', () => {
  const w = dom('<body><script>alert(1)</script><img src="/a.png" onerror="x()"><a href="javascript:void(0)">x</a></body>');
  const snap = serializeNode(w.document, new Mirror(), cfg)!;
  assert.equal(find(snap, (n) => n.t === 'el' && n.tag === 'script'), undefined);
  const img = find(snap, (n) => n.t === 'el' && n.tag === 'img') as any;
  assert.equal(img.a.src, 'https://shop.example.com/a.png');
  assert.equal(img.a.onerror, undefined);
});

test('snapshot masks input values and text in mask regions, blocks blocked regions', () => {
  const w = dom('<body><input id="i" value="secret"><p data-journey-mask>Jane Doe</p><div data-journey-block><b>hidden</b></div><p>mail me at a@b.com</p></body>');
  (w.document.getElementById('i') as HTMLInputElement).value = 'typed';
  const json = JSON.stringify(serializeNode(w.document, new Mirror(), cfg));
  assert.ok(!json.includes('secret'));
  assert.ok(!json.includes('typed'));
  assert.ok(!json.includes('Jane Doe'));
  assert.ok(!json.includes('hidden'));
  assert.ok(!json.includes('a@b.com'));
  assert.ok(json.includes('data-journey-blocked'));
});

test('mutations: add, remove, attribute and text changes are captured', async () => {
  const w = dom('<body><ul id="l"><li>a</li></ul><p id="p">x</p></body>');
  const mirror = new Mirror();
  serializeNode(w.document, mirror, cfg);
  const records: MutationRecord[] = [];
  const mo = new w.MutationObserver((r) => records.push(...r));
  mo.observe(w.document, { childList: true, subtree: true, attributes: true, characterData: true });
  const d = w.document;
  const li = d.createElement('li');
  li.textContent = 'b';
  d.getElementById('l')!.appendChild(li);
  d.getElementById('l')!.firstElementChild!.remove();
  d.getElementById('p')!.setAttribute('class', 'hot');
  (d.getElementById('p')!.firstChild as Text).data = 'y';
  records.push(...mo.takeRecords());
  const m = processMutations(records, mirror, cfg);
  assert.equal(m.adds.length, 1);
  assert.equal(m.removes.length, 1);
  assert.deepEqual(m.attrs[0].a, { class: 'hot' });
  assert.equal(m.texts[0].v, 'y');
});

/** Fuzz: apply random DOM mutations, record them, replay into a second DOM and compare. */
test('replay reproduces the recorded DOM after random mutations (fuzz)', () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let round = 0; round < 25; round++) {
    const w = dom('<body><div id="root"><p>hello</p><ul><li>1</li><li>2</li></ul></div></body>');
    const d = w.document;
    const mirror = new Mirror();
    const snap = serializeNode(d, mirror, { ...cfg, scrubPatterns: false })!;
    const target = dom('<body></body>');
    const rb = new Rebuilder(target.document);
    rb.snapshot(snap);
    const mo = new w.MutationObserver(() => {});
    mo.observe(d, { childList: true, subtree: true, attributes: true, characterData: true });
    for (let batch = 0; batch < 8; batch++) {
      for (let op = 0; op < 6; op++) {
        const all = Array.from(d.getElementById('root')!.querySelectorAll('*')).concat(d.getElementById('root')!);
        const el = all[Math.floor(rand() * all.length)];
        const r = rand();
        if (r < 0.35) {
          const n = d.createElement(rand() < 0.5 ? 'span' : 'div');
          n.textContent = `t${Math.floor(rand() * 100)}`;
          const ref = el.childNodes[Math.floor(rand() * (el.childNodes.length + 1))] || null;
          el.insertBefore(n, ref);
        } else if (r < 0.55 && el.id !== 'root') {
          el.remove();
        } else if (r < 0.75) {
          el.setAttribute('data-x', String(Math.floor(rand() * 10)));
        } else if (r < 0.85 && el.id !== 'root' && el.parentElement) {
          // move: remove + insert elsewhere in the same batch
          d.getElementById('root')!.appendChild(el);
        } else {
          const t = Array.from(el.childNodes).find((c) => c.nodeType === 3) as Text | undefined;
          if (t) t.data = `x${Math.floor(rand() * 100)}`;
        }
      }
      rb.mutate(processMutations(mo.takeRecords(), mirror, { ...cfg, scrubPatterns: false }));
    }
    assert.equal(normalize(target.document.body.innerHTML), normalize(d.body.innerHTML), `round ${round}`);
    assert.equal(rb.warnings, 0, `round ${round} warnings`);
  }
});

test('rebuilder tolerates unknown nodes and bad attributes without throwing', () => {
  const target = dom('<body></body>');
  const rb = new Rebuilder(target.document);
  rb.mutate({ adds: [{ parent: 999, next: null, node: { id: 1, t: 'txt', v: 'x' } }], removes: [{ parent: 1, id: 5 }], attrs: [{ id: 77, a: { a: 'b' } }], texts: [{ id: 3, v: 'q' }] });
  assert.equal(rb.warnings, 4);
});

test('rebuilder strips javascript: URLs', () => {
  const target = dom('<body></body>');
  const rb = new Rebuilder(target.document);
  rb.snapshot({ id: 1, t: 'doc', c: [{ id: 2, t: 'el', tag: 'html', a: {}, c: [{ id: 3, t: 'el', tag: 'body', a: {}, c: [{ id: 4, t: 'el', tag: 'a', a: { href: 'javascript:alert(1)' }, c: [] }] }] }] });
  assert.equal(target.document.querySelector('a')!.getAttribute('href'), null);
});

test('player: seek(0) shows the first snapshot even when it comes after meta events', async () => {
  const { Player } = await import('../src/replay/rebuild');
  const target = dom('<body></body>');
  const sizes: number[] = [];
  const rb = new Rebuilder(target.document, { onViewport: (w) => sizes.push(w) });
  const snap = { id: 1, t: 'doc' as const, c: [{ id: 2, t: 'el' as const, tag: 'html', a: {}, c: [{ id: 3, t: 'el' as const, tag: 'body', a: {}, c: [{ id: 4, t: 'txt' as const, v: 'hello' }] }] }] };
  const p = new Player([
    { type: 'meta', ts: 100, url: 'u', title: '', w: 900, h: 600, ua: '', ref: '' },
    { type: 'snapshot', ts: 105, node: snap, sx: 0, sy: 0 },
    { type: 'mutation', ts: 2000, m: { adds: [], removes: [], attrs: [], texts: [{ id: 4, v: 'bye' }] } },
    { type: 'mutation', ts: 60000, m: { adds: [], removes: [], attrs: [], texts: [{ id: 4, v: 'late' }] } },
  ], rb);
  p.seek(0);
  assert.equal(target.document.body.textContent, 'hello');
  assert.deepEqual(sizes, [900]);
  p.tick(2000);
  assert.equal(target.document.body.textContent, 'bye');
  p.tick(10); // idle gap is skipped
  assert.ok(p.currentTime > 50000);
  p.seek(1000); // seeking backwards rebuilds from the snapshot
  assert.equal(target.document.body.textContent, 'hello');
  while (p.tick(1000));
  assert.equal(target.document.body.textContent, 'late');
});
