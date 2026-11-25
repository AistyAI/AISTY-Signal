import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { Evidence, Person, Provider, ScanRun, StoreData } from './types.js';

const FILE = path.join(config.dataDir, 'signal.json');

function empty(): StoreData {
  return { version: 1, people: {}, evidence: [], scans: [] };
}

let data: StoreData = empty();
let persist = true;

export function loadStore(opts: { inMemory?: boolean } = {}): void {
  persist = !opts.inMemory;
  if (!persist) {
    data = empty();
    return;
  }
  try {
    data = JSON.parse(fs.readFileSync(FILE, 'utf8')) as StoreData;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[store] could not read ${FILE}:`, err);
    data = empty();
  }
}

export function saveStore(): void {
  if (!persist) return;
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export const getStore = (): Readonly<StoreData> => data;

export function upsertPerson(p: Omit<Person, 'sources'>, source: Provider): void {
  const key = p.email.toLowerCase();
  const cur = data.people[key];
  data.people[key] = {
    email: key,
    name: p.name || cur?.name,
    department: p.department || cur?.department,
    jobTitle: p.jobTitle || cur?.jobTitle,
    sources: [...new Set([...(cur?.sources ?? []), source])],
  };
}

/** Replace all evidence from the given providers with a fresh set (one scan = one source of truth). */
export function replaceEvidence(providers: Provider[], fresh: Evidence[]): void {
  const keep = data.evidence.filter((e) => !providers.includes(e.source));
  const seen = new Set<string>();
  data.evidence = [...keep, ...fresh].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

export function recordScan(run: ScanRun): void {
  data.scans = [run, ...data.scans.filter((s) => s.id !== run.id)].slice(0, 20);
}

export function clearStore(): void {
  data = empty();
  saveStore();
}

export function replaceAll(next: StoreData): void {
  data = next;
  saveStore();
}
