// Low-level DOM helpers: React-safe value setting, realistic clicks, and waits.

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const IS_JSDOM = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent);

export function isVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  if (el.closest('[hidden], [aria-hidden="true"], template')) return false;
  // Chrome 105+: one native call instead of a computed-style walk up the tree.
  const native = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (!IS_JSDOM && typeof native === 'function') {
    if (!native.call(el, { visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  }
  for (let n: Element | null = el; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
  }
  if (IS_JSDOM) return true;
  const r = el.getBoundingClientRect();
  return r.width > 0 || r.height > 0 || el.getClientRects().length > 0;
}

/** Text content without the text of nested form controls / option lists. */
export function cleanText(el: Element | null | undefined): string {
  if (!el) return '';
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('input, select, textarea, option, script, style, [role="listbox"], .rej-ignore').forEach((n) => n.remove());
  return squash(clone.textContent ?? '');
}

export function squash(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function nativeSetter(el: HTMLElement): ((v: string) => void) | undefined {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, 'value')?.set;
}

/** Set a value so React/Vue/Angular controlled inputs notice it. */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const setter = nativeSetter(el);
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function fire(el: Element, type: string, init: EventInit = {}): void {
  el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
}

/** A click with the full pointer/mouse sequence; many custom widgets listen to mousedown. */
export function realClick(el: Element): void {
  const opts = { bubbles: true, cancelable: true, button: 0 };
  const P = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  el.dispatchEvent(new P('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  if (el instanceof HTMLElement) el.focus?.({ preventScroll: true });
  el.dispatchEvent(new P('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}

export function pressKey(el: Element, key: string): void {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  const keyCode = ({ Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Tab: 9, Backspace: 8 } as Record<string, number>)[key] ?? key.charCodeAt(0);
  for (const type of ['keydown', 'keypress', 'keyup']) {
    if (type === 'keypress' && key.length > 1 && key !== 'Enter') continue;
    el.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true } as KeyboardEventInit));
  }
}

/** Type text into an input the way a search box expects: set value, then key + input events. */
export function typeText(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  el.focus({ preventScroll: true });
  const setter = nativeSetter(el);
  if (setter) setter.call(el, text);
  else el.value = text;
  const last = text.slice(-1) || ' ';
  el.dispatchEvent(new KeyboardEvent('keydown', { key: last, bubbles: true }));
  el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
  el.dispatchEvent(new KeyboardEvent('keyup', { key: last, bubbles: true }));
}

export interface WaitOpts {
  timeout?: number;
  interval?: number;
  root?: Node;
}

/** Resolve with the first truthy result of `fn`, re-checking on DOM mutations and on an interval. */
export function waitFor<T>(fn: () => T | null | undefined | false, opts: WaitOpts = {}): Promise<T | null> {
  const { timeout = 5000, interval = 100, root = document } = opts;
  return new Promise((resolve) => {
    let done = false;
    const check = () => {
      if (done) return;
      let v: T | null | undefined | false;
      try {
        v = fn();
      } catch {
        v = null;
      }
      if (v) finish(v);
    };
    const finish = (v: T | null) => {
      done = true;
      obs.disconnect();
      clearInterval(iv);
      clearTimeout(to);
      resolve(v);
    };
    const obs = new MutationObserver(check);
    obs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    const iv = setInterval(check, interval);
    const to = setTimeout(() => finish(null), timeout);
    check();
  });
}

/** Resolve once the DOM under `root` has had no mutations for `quiet` ms (or `max` ms elapsed). */
export function waitForSettle(quiet = 400, max = 5000, root: Node = document): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(done, quiet);
    const hard = setTimeout(done, max);
    const obs = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(done, quiet);
    });
    obs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    function done() {
      obs.disconnect();
      clearTimeout(timer);
      clearTimeout(hard);
      resolve();
    }
  });
}

export function byText<T extends Element>(selector: string, re: RegExp, root: ParentNode = document): T | undefined {
  return Array.from(root.querySelectorAll<T>(selector)).find((el) => isVisible(el) && re.test(cleanText(el)));
}
