// Inject into a live page (debugging only): exposes the engine's dropdown pieces as window.__eng.
import { comboboxDisplay, scanFields } from '../src/engine/fields';
import { fillField, peekOptions } from '../src/engine/widgets';

(window as unknown as { __eng: unknown }).__eng = {
  fields: () => scanFields().map((f) => ({ kind: f.kind, label: f.label.slice(0, 70), id: f.el.id })),
  async peek(re: string) {
    const f = scanFields().find((x) => new RegExp(re, 'i').test(x.label))!;
    return peekOptions(f);
  },
  async pick(re: string, text: string) {
    const f = scanFields().find((x) => new RegExp(re, 'i').test(x.label))!;
    const r = await fillField(f, { text }, true);
    return { r, display: comboboxDisplay(f.el) };
  },
};
