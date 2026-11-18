import { classify } from '../engine/answers';
import { currentValue, scanFields } from '../engine/fields';

// "Save page snapshot" (side panel): the page's structure, including inside web
// components (open shadow roots, which a normal Save As leaves out), and what
// the scanner made of each field. For bug reports when a site isn't filled right.

export interface SnapshotField {
  kind: string;
  label: string;
  required: boolean;
  /** What the rules think it asks. */
  key?: string;
  value: string;
  choices?: string[];
  /** Tag, id and classes of the element, to find it in the HTML. */
  el: string;
}

export interface Snapshot {
  url: string;
  title: string;
  top: boolean;
  fields: SnapshotField[];
  html: string;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'LINK', 'META', 'IFRAME', 'TEMPLATE']);
const MAX_CHARS = 4_000_000;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function describe(el: Element): string {
  const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}` : '';
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`;
}

/** Serialize with open shadow roots as <template shadowrootmode="open"> and live input values as data-live-* attributes. */
function serialize(node: Node, out: string[], budget: { left: number }): void {
  if (budget.left <= 0) return;
  if (node.nodeType === Node.TEXT_NODE) {
    const t = node.nodeValue ?? '';
    if (t.trim()) {
      out.push(esc(t));
      budget.left -= t.length;
    }
    return;
  }
  if (!(node instanceof Element) || SKIP.has(node.tagName.toUpperCase())) return;
  const tag = node.tagName.toLowerCase();
  const attrs = Array.from(node.attributes)
    .filter((a) => !a.name.startsWith('on') && a.name !== 'style' && a.value.length < 300)
    .map((a) => ` ${a.name}="${esc(a.value)}"`)
    .join('');
  let live = '';
  if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) {
    const secret = node instanceof HTMLInputElement && node.type === 'password';
    live += ` data-live-value="${secret ? '***' : esc(node.value.slice(0, 200))}"`;
    if (node instanceof HTMLInputElement && (node.type === 'radio' || node.type === 'checkbox')) live += ` data-live-checked="${node.checked}"`;
  }
  out.push(`<${tag}${attrs}${live}>`);
  budget.left -= tag.length + attrs.length + 2;
  if (node.shadowRoot) {
    out.push('<template shadowrootmode="open">');
    for (const c of Array.from(node.shadowRoot.childNodes)) serialize(c, out, budget);
    out.push('</template>');
  }
  for (const c of Array.from(node.childNodes)) serialize(c, out, budget);
  if (!VOID.has(tag)) out.push(`</${tag}>`);
}

const VOID = new Set(['input', 'img', 'br', 'hr', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

export function snapshot(): Snapshot {
  const fields = scanFields().map((f) => ({
    kind: f.kind,
    label: f.label,
    required: f.required,
    key: classify(f, [], [])?.key,
    value: f.inputType === 'password' ? '***' : currentValue(f).slice(0, 120),
    choices: f.choices?.map((c) => c.label),
    el: describe(f.el),
  }));
  const out: string[] = [];
  if (document.body) serialize(document.body, out, { left: MAX_CHARS });
  return { url: location.href, title: document.title, top: window === window.top, fields, html: out.join('') };
}
