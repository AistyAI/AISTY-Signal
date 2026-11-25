import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config, ROOT } from './config.js';
import { changePassword, isAuthenticated, login, logout, needsSetup, requireAppHeader, requireAuth, setup } from './auth.js';
import { buildFindings, summarise } from './aggregate.js';
import { vendors } from './catalogue.js';
import { seedDemo } from './demo.js';
import { importCsv } from './import-csv.js';
import { GOOGLE_SCOPES, testGoogle } from './providers/google.js';
import { MICROSOFT_PERMISSIONS, testMicrosoft } from './providers/microsoft.js';
import { availableProviders, scanState, startScan } from './scan.js';
import {
  googleConnection,
  loadSettings,
  microsoftConnection,
  passwordSource,
  removeGoogle,
  removeMicrosoft,
  saveGoogle,
  saveMicrosoft,
  saveScanSettings,
  scanSettings,
  setupCode,
  updatedAt,
} from './settings.js';
import { clearStore, getStore, loadStore } from './store.js';
import { EVIDENCE_LABELS, type Provider } from './types.js';
import { errorMessage, toCsv } from './util.js';

loadSettings({ inMemory: config.demo });
loadStore({ inMemory: config.demo });
if (config.demo) {
  seedDemo();
  // Fictional connections, held in memory only, so the Connections tab looks like a real install.
  saveGoogle({
    serviceAccountJson: JSON.stringify({
      type: 'service_account',
      client_email: 'aisty-signal@acme-it.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\ndemo\n-----END PRIVATE KEY-----\n',
      client_id: '104857600012345678901',
      project_id: 'acme-it',
    }),
    adminEmail: 'ravi.shah@acme.com',
  });
  saveMicrosoft({ tenantId: 'acme.onmicrosoft.com', clientId: '3f2c8a91-5b7e-4d2a-9c61-0e8b7a4d1f23', clientSecret: 'demo-secret-value-x7Qa' });
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  next();
});

app.use(express.json({ limit: '6mb' }));
app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }));

/**
 * Return URL for Microsoft's admin-consent page. It only reports the outcome back to the
 * dashboard and changes no state, so it doesn't need a session.
 */
app.get('/connect/microsoft/callback', (req, res) => {
  const ok = req.query.admin_consent === 'True' && !req.query.error;
  const params = new URLSearchParams({ ms_consent: ok ? 'ok' : 'error' });
  if (!ok) params.set('message', String(req.query.error_description ?? req.query.error ?? 'Consent was not granted').slice(0, 300));
  res.redirect(`/?${params}#connections`);
});

const api = express.Router();
api.use(requireAppHeader);

api.get('/session', (req, res) => {
  res.json({ authenticated: isAuthenticated(req), needsSetup: needsSetup(), demo: config.demo, aisty: config.aisty });
});
api.post('/setup', setup);
api.post('/login', login);
api.post('/logout', logout);

api.use(requireAuth);

function connectionsView() {
  const g = safe(googleConnection);
  const m = safe(microsoftConnection);
  return {
    google: {
      connected: Boolean(g.value),
      error: g.error,
      source: g.value?.source ?? null,
      serviceAccountEmail: g.value?.credentials.client_email ?? null,
      clientId: g.value?.credentials.client_id ?? null,
      projectId: g.value?.credentials.project_id ?? null,
      adminEmail: g.value?.adminEmail ?? null,
      customerId: g.value?.customerId ?? 'my_customer',
      scanMail: g.value?.scanMail ?? true,
      updatedAt: updatedAt('google') ?? null,
      scopes: GOOGLE_SCOPES,
    },
    microsoft: {
      connected: Boolean(m.value),
      error: m.error,
      source: m.value?.source ?? null,
      tenantId: m.value?.tenantId ?? null,
      clientId: m.value?.clientId ?? null,
      secretHint: m.value ? `••••${m.value.clientSecret.slice(-4)}` : null,
      scanMail: m.value?.scanMail ?? true,
      updatedAt: updatedAt('microsoft') ?? null,
      permissions: MICROSOFT_PERMISSIONS,
    },
  };
}

/** A corrupt or undecryptable stored secret shouldn't take the dashboard down. */
function safe<T>(fn: () => T): { value: T | null; error: string | null } {
  try {
    return { value: fn(), error: null };
  } catch (err) {
    return { value: null, error: errorMessage(err) };
  }
}

api.get('/status', (_req, res) => {
  const s = scanState();
  const store = getStore();
  res.json({
    demo: config.demo,
    connections: connectionsView(),
    passwordSource: passwordSource(),
    settings: scanSettings(),
    scan: { running: s.running, progress: s.progress },
    lastScan: store.scans[0] ?? null,
    catalogueSize: vendors.length,
  });
});

api.put('/connections/google', (req, res) => {
  try {
    saveGoogle(req.body ?? {});
    res.json({ ok: true, connections: connectionsView() });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});
api.delete('/connections/google', (_req, res) => {
  removeGoogle();
  res.json({ ok: true, connections: connectionsView() });
});
api.put('/connections/microsoft', (req, res) => {
  try {
    saveMicrosoft(req.body ?? {});
    res.json({ ok: true, connections: connectionsView() });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});
api.delete('/connections/microsoft', (_req, res) => {
  removeMicrosoft();
  res.json({ ok: true, connections: connectionsView() });
});

api.put('/settings/scan', (req, res) => {
  try {
    saveScanSettings(req.body ?? {});
    res.json({ ok: true, settings: scanSettings() });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});
api.post('/password', changePassword);

api.get('/findings', (_req, res) => {
  const store = getStore();
  const findings = buildFindings(store);
  res.json({ summary: summarise(store, findings), findings, people: Object.values(store.people), labels: EVIDENCE_LABELS });
});

api.get('/export.csv', (_req, res) => {
  const findings = buildFindings(getStore());
  const rows = [
    ['Email', 'Name', 'Department', 'Job title', 'AI tool', 'Category', 'Confidence', 'Paid', 'First seen', 'Last seen', 'Evidence', 'Sources'],
    ...findings.map((f) => [
      f.userEmail,
      f.name,
      f.department,
      f.jobTitle,
      f.vendorName,
      f.category,
      f.confidence,
      f.paid ? 'yes' : 'no',
      f.firstSeen?.slice(0, 10),
      f.lastSeen?.slice(0, 10),
      f.kinds.map((k) => EVIDENCE_LABELS[k]).join('; '),
      f.sources.join('; '),
    ]),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="aisty-signal-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + toCsv(rows));
});

api.post('/scan', (req, res) => {
  if (config.demo) {
    seedDemo();
    res.json({ ok: true, demo: true });
    return;
  }
  try {
    const providers = Array.isArray(req.body?.providers) ? (req.body.providers as Provider[]) : undefined;
    res.json({ ok: true, run: startScan(providers) });
  } catch (err) {
    res.status(409).json({ error: errorMessage(err) });
  }
});

api.post('/test/:provider', async (req, res) => {
  const p = req.params.provider;
  if (config.demo) {
    res.json({ ok: true, message: 'Demo mode: details saved in memory only. No real connection was made.' });
    return;
  }
  try {
    if (p === 'google') res.json({ ok: true, message: await testGoogle() });
    else if (p === 'microsoft') res.json({ ok: true, message: await testMicrosoft() });
    else res.status(404).json({ ok: false, message: 'Unknown connector' });
  } catch (err) {
    res.status(502).json({ ok: false, message: errorMessage(err) });
  }
});

api.post('/import/csv', (req, res) => {
  const csv = typeof req.body?.csv === 'string' ? req.body.csv : '';
  if (!csv) {
    res.status(400).json({ error: 'No CSV content received' });
    return;
  }
  try {
    res.json({ ok: true, result: importCsv(csv, { replace: req.body?.replace !== false }) });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

api.get('/catalogue', (_req, res) => {
  res.json(vendors.map(({ id, name, category, website }) => ({ id, name, category, website })));
});

api.delete('/data', (_req, res) => {
  if (scanState().running) {
    res.status(409).json({ error: 'Wait for the running scan to finish' });
    return;
  }
  if (config.demo) seedDemo();
  else clearStore();
  res.json({ ok: true });
});

app.use('/api', api);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

app.listen(config.port, config.host, () => {
  const url = `http://localhost:${config.port}`;
  console.log(`\n  Aisty Signal is running at ${url}`);
  if (config.host !== '127.0.0.1' && config.host !== 'localhost') console.log(`  Listening on ${config.host}. Put it behind HTTPS before exposing it.`);
  if (config.demo) {
    console.log('  Demo mode: showing fictional acme.com data.');
  } else if (needsSetup()) {
    console.log('\n  ┌──────────────────────────────────────────────┐');
    console.log(`  │  First-run setup code:  ${setupCode.padEnd(21)}│`);
    console.log('  │  Open the dashboard and enter this code to   │');
    console.log('  │  create your admin password.                 │');
    console.log('  └──────────────────────────────────────────────┘');
  } else {
    const connected = availableProviders();
    console.log(`  Connected: ${connected.length ? connected.join(', ') : 'nothing yet. Open the dashboard → Connections.'}`);
  }
  console.log('');
});
