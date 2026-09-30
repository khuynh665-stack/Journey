import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRIVACY, inputValue, scrub, shouldMaskInput, stars } from '../src/sdk/mask';
import { dom } from './helpers';

const cfg = DEFAULT_PRIVACY;

test('stars keeps length and whitespace', () => {
  assert.equal(stars('ab c'), '** *');
});

test('scrub removes emails, card numbers, SSNs and phone numbers from text', () => {
  const out = scrub('Mail jane.doe@example.com, card 4111 1111 1111 1111, ssn 123-45-6789, call (555) 123-4567 now', cfg);
  assert.ok(!out.includes('jane.doe'));
  assert.ok(!out.includes('4111'));
  assert.ok(!out.includes('6789'));
  assert.ok(!out.includes('555'));
  assert.ok(out.startsWith('Mail '));
  assert.ok(out.endsWith(' now'));
});

test('scrub can be disabled', () => {
  assert.equal(scrub('a@b.co', { ...cfg, scrubPatterns: false }), 'a@b.co');
});

test('inputs are masked by default and can be unmasked explicitly', () => {
  const w = dom('<body><input id="q"><div data-journey-unmask><input id="search"></div></body>');
  const q = w.document.getElementById('q')!;
  const s = w.document.getElementById('search')!;
  assert.equal(shouldMaskInput(q, cfg), true);
  assert.equal(shouldMaskInput(s, cfg), false);
  assert.deepEqual(inputValue(s, 'boots', cfg), { v: 'boots', masked: false });
  assert.deepEqual(inputValue(q, 'boots', cfg), { v: '*****', masked: true });
});

test('sensitive fields stay masked even inside an unmask region', () => {
  const w = dom(`<body><div data-journey-unmask>
    <input id="p" type="password"><input id="e" type="email"><input id="c" autocomplete="cc-number"><input id="t" name="api_token"></div></body>`);
  for (const id of ['p', 'e', 'c', 't']) assert.equal(shouldMaskInput(w.document.getElementById(id)!, cfg), true, id);
});

test('checkbox values are recorded, select values are scrubbed not starred', () => {
  const w = dom('<body><input id="c" type="checkbox"><select id="s"><option>x</option></select></body>');
  assert.deepEqual(inputValue(w.document.getElementById('c')!, 'true', cfg), { v: 'true', masked: false });
  assert.deepEqual(inputValue(w.document.getElementById('s')!, 'x', cfg), { v: 'x', masked: false });
});

test('an invalid selector in config does not throw', () => {
  const w = dom('<body><input id="q"></body>');
  assert.equal(shouldMaskInput(w.document.getElementById('q')!, { ...cfg, maskSelector: '[[bad', unmaskSelector: '::nope(' }), true);
});
