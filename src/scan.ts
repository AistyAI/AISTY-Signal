import crypto from 'node:crypto';
import { scanGoogle } from './providers/google.js';
import { scanMicrosoft } from './providers/microsoft.js';
import { googleConnection, microsoftConnection, scanSettings } from './settings.js';
import { getStore, recordScan, replaceEvidence, saveStore, upsertPerson } from './store.js';
import { hashId, errorMessage } from './util.js';
import type { Evidence, Provider, ScanContext, ScanRun } from './types.js';

export interface ScanState {
  running: boolean;
  progress: string;
  run?: ScanRun;
}

const state: ScanState = { running: false, progress: '' };
export const scanState = (): ScanState => state;

export function availableProviders(): Provider[] {
  const p: Provider[] = [];
  if (googleConnection()) p.push('google');
  if (microsoftConnection()) p.push('microsoft');
  return p;
}

/** Start a scan in the background. Returns the run, or throws if one is already running. */
export function startScan(requested?: Provider[]): ScanRun {
  if (state.running) throw new Error('A scan is already running');
  const available = availableProviders();
  const providers = (requested?.length ? requested : available).filter((p) => available.includes(p));
  if (!providers.length) throw new Error('Connect Google Workspace or Microsoft 365 first (Connections tab).');

  const run: ScanRun = {
    id: crypto.randomUUID(),
    startedAt: new Date().toISOString(),
    providers,
    status: 'running',
    warnings: [],
    stats: {},
  };
  state.running = true;
  state.run = run;
  state.progress = 'Starting';
  recordScan(run);

  void execute(run).finally(() => {
    state.running = false;
  });
  return run;
}

async function execute(run: ScanRun): Promise<void> {
  const fresh: Evidence[] = [];
  const succeeded: Provider[] = [];
  const settings = scanSettings();
  const ctx: ScanContext = {
    ...settings,
    addPerson: (p, source) => upsertPerson(p, source),
    addEvidence: (e) =>
      fresh.push({ ...e, userEmail: e.userEmail.toLowerCase(), id: hashId(e.source, e.kind, e.userEmail.toLowerCase(), e.vendorId, e.detail, e.observedAt) }),
    warn: (m) => {
      if (run.warnings.length < 200) run.warnings.push(m);
      console.warn('[scan]', m);
    },
    progress: (m) => {
      state.progress = m;
      console.log('[scan]', m);
    },
    bump: (k, by = 1) => {
      run.stats[k] = (run.stats[k] ?? 0) + by;
    },
  };

  for (const provider of run.providers) {
    try {
      if (provider === 'google') await scanGoogle(ctx);
      if (provider === 'microsoft') await scanMicrosoft(ctx);
      succeeded.push(provider);
    } catch (err) {
      ctx.warn(`${provider}: scan failed: ${errorMessage(err)}`);
    }
  }

  // Only replace results for providers that completed, so a failed run never wipes good data.
  replaceEvidence(
    succeeded,
    fresh.filter((e) => succeeded.includes(e.source)),
  );
  run.finishedAt = new Date().toISOString();
  run.status = succeeded.length ? 'done' : 'failed';
  run.stats.evidence = fresh.length;
  run.stats.findings = new Set(getStore().evidence.map((e) => `${e.userEmail}|${e.vendorId}`)).size;
  recordScan(run);
  saveStore();
  state.progress = run.status === 'done' ? 'Scan complete' : 'Scan failed';
}
