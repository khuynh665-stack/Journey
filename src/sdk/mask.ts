/**
 * Privacy controls. Everything that leaves the browser goes through here.
 * Defaults are strict (Glassbox/Discover style): all input values are masked
 * unless an element opts out with the unmask selector, sensitive input types
 * are always masked, and PII patterns found in text are scrubbed.
 */

export interface PrivacyConfig {
  maskAllInputs: boolean;
  maskSelector: string;     // mask text + values inside these elements
  unmaskSelector: string;   // allow input values inside these elements (never overrides ALWAYS_MASK)
  blockSelector: string;    // do not record content at all, replaced by an empty placeholder
  scrubPatterns: boolean;   // scrub emails, card numbers, SSNs, phone numbers from free text
}

export const DEFAULT_PRIVACY: PrivacyConfig = {
  maskAllInputs: true,
  maskSelector: '[data-journey-mask]',
  unmaskSelector: '[data-journey-unmask]',
  blockSelector: '[data-journey-block]',
  scrubPatterns: true,
};

const ALWAYS_MASK_TYPES = new Set(['password', 'email', 'tel', 'hidden']);
const SENSITIVE_AUTOCOMPLETE = /^(cc-|current-password|new-password|one-time-code)/;
const SENSITIVE_NAME = /(pass|pwd|secret|token|card|cvv|cvc|ssn|iban|account.?num)/i;

const PATTERNS: RegExp[] = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,              // email
  /\b(?:\d[ -]?){13,19}\b/g,                                // card-like digit runs
  /\b\d{3}-\d{2}-\d{4}\b/g,                                 // US SSN
  /(?:\+?\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]\d{4}\b/g, // phone
];

export function stars(v: string): string {
  return v.replace(/[^\s]/g, '*');
}

export function scrub(text: string, cfg: PrivacyConfig): string {
  if (!cfg.scrubPatterns || !text) return text;
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, (m) => stars(m));
  return out;
}

function closestMatch(el: Element | null, selector: string): boolean {
  if (!el || !selector) return false;
  try {
    return el.closest(selector) !== null;
  } catch {
    return false; // invalid selector from config must not break capture
  }
}

export function isBlocked(el: Element, cfg: PrivacyConfig): boolean {
  return closestMatch(el, cfg.blockSelector);
}

export function isTextMasked(el: Element | null, cfg: PrivacyConfig): boolean {
  return closestMatch(el, cfg.maskSelector);
}

/** Whether the value of a form control must be masked. */
export function shouldMaskInput(el: Element, cfg: PrivacyConfig): boolean {
  const type = (el.getAttribute('type') || '').toLowerCase();
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  const name = `${el.getAttribute('name') || ''} ${el.getAttribute('id') || ''}`;
  if (ALWAYS_MASK_TYPES.has(type) || SENSITIVE_AUTOCOMPLETE.test(ac) || SENSITIVE_NAME.test(name)) return true;
  if (closestMatch(el, cfg.maskSelector)) return true;
  if (closestMatch(el, cfg.unmaskSelector)) return false;
  return cfg.maskAllInputs;
}

/** Returns the value that may be recorded for a form control, plus whether it was masked. */
export function inputValue(el: Element, raw: string, cfg: PrivacyConfig): { v: string; masked: boolean } {
  const type = (el.getAttribute('type') || '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') return { v: raw, masked: false };
  if (el.tagName === 'SELECT') return { v: scrub(raw, cfg), masked: false };
  if (shouldMaskInput(el, cfg)) return { v: stars(raw), masked: true };
  return { v: scrub(raw, cfg), masked: false };
}

export function maskText(text: string, parent: Element | null, cfg: PrivacyConfig): string {
  if (isTextMasked(parent, cfg)) return stars(text);
  return scrub(text, cfg);
}
