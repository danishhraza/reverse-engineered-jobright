// Cancel + progress for the running fill. One fill runs per frame at a time,
// so module state is enough.

export class Cancelled extends Error {
  constructor() {
    super('Stopped');
    this.name = 'Cancelled';
  }
}

let cancelled = false;
let sink: ((text: string) => void) | null = null;

/** Start of a fill: clear any earlier cancel and route status lines to `onStatus`. */
export function begin(onStatus?: (text: string) => void): void {
  cancelled = false;
  sink = onStatus ?? null;
}

export function end(): void {
  sink = null;
}

export function cancel(): void {
  cancelled = true;
}

export function isCancelled(): boolean {
  return cancelled;
}

/** Throw if you pressed Cancel. Call between steps. */
export function checkCancel(): void {
  if (cancelled) throw new Cancelled();
}

/** Rethrow a cancel caught by a try/catch that's meant for real errors. */
export function rethrowCancel(e: unknown): void {
  if (e instanceof Cancelled) throw e;
}

/** What the fill is doing right now, shown in the side panel and on the floating button. */
export function status(text: string): void {
  sink?.(text);
}
