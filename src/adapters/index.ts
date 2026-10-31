import { ashby, generic, greenhouse, lever } from './simple';
import { workday } from './workday';
import type { Adapter } from './types';

const ADAPTERS: Adapter[] = [workday, greenhouse, ashby, lever, generic];

export function pickAdapter(loc: Location = location, doc: Document = document): Adapter {
  return ADAPTERS.find((a) => a.detect(loc, doc)) ?? generic;
}

export function isKnownAts(loc: Location = location, doc: Document = document): boolean {
  return pickAdapter(loc, doc) !== generic;
}
