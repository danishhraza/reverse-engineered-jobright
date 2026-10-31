// jsdom has no DataTransfer, and only accepts a real FileList for input.files.
// Give tests a minimal stand-in for both.

class FakeDataTransfer {
  private list: File[] = [];
  items = { add: (f: File) => void this.list.push(f) };
  get files() {
    const arr = [...this.list] as unknown as FileList & File[];
    (arr as unknown as { item: (i: number) => File }).item = (i: number) => this.list[i];
    return arr;
  }
}

if (typeof (globalThis as { DataTransfer?: unknown }).DataTransfer === 'undefined') {
  (globalThis as { DataTransfer?: unknown }).DataTransfer = FakeDataTransfer;
  const store = new WeakMap<HTMLInputElement, FileList>();
  Object.defineProperty(HTMLInputElement.prototype, 'files', {
    configurable: true,
    get(this: HTMLInputElement) {
      return store.get(this) ?? null;
    },
    set(this: HTMLInputElement, v: FileList) {
      store.set(this, v);
    },
  });
}
