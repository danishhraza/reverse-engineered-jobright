import type { Profile } from '../types';
import type { Field } from '../engine/fields';

export interface FillContext {
  profile: Profile;
  resume?: File;
  overwrite: boolean;
  /** Field ids an adapter already handled; the generic pass skips them. */
  handled: Set<string>;
  /** Adapter-produced report rows (e.g. repeatable sections). */
  extra: import('../types').FieldReport[];
}

export interface Adapter {
  name: string;
  detect(loc: Location, doc: Document): boolean;
  /** The resume <input type=file>, if the generic search would get it wrong. */
  resumeInput?(fields: Field[]): HTMLInputElement | null;
  /** Wait until the site finished processing the uploaded resume. */
  waitResumeProcessed?(input: HTMLInputElement, file: File): Promise<boolean>;
  /** Fill things the generic engine can't (repeatable Work/Education sections, skills). */
  fillSpecial?(ctx: FillContext): Promise<void>;
  /** Multi-page forms. */
  nextButton?(): HTMLElement | null;
  isFinalPage?(): boolean;
  pageSignature?(): string;
  hasErrors?(): boolean;
}
