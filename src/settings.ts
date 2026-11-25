/**
 * Settings and connections managed from the UI, persisted to data/settings.json.
 * Secrets (Google key, Microsoft client secret) are encrypted with AES-256-GCM.
 * The key comes from SIGNAL_ENCRYPTION_KEY or an auto-generated data/secret.key.
 *
 * Environment variables still work as a fallback (handy for Docker / headless installs);
 * anything saved in the UI takes precedence.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const FILE = path.join(config.dataDir, 'settings.json');
const KEY_FILE = path.join(config.dataDir, 'secret.key');

interface Stored {
  version: 1;
  passwordHash?: string;
  sessionSecret?: string;
  google?: { serviceAccount: string; adminEmail: string; customerId: string; scanMail: boolean; updatedAt: string };
  microsoft?: { tenantId: string; clientId: string; clientSecret: string; scanMail: boolean; updatedAt: string };
  scan?: { lookbackDays?: number; maxMessagesPerUser?: number; storeSubjects?: boolean };
}

let s: Stored = { version: 1 };
let persist = true;

export function loadSettings(opts: { inMemory?: boolean } = {}): void {
  persist = !opts.inMemory;
  if (!persist) return;
  try {
    s = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Stored;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Could not read ${FILE}: ${(err as Error).message}`);
  }
}

function save(): void {
  if (!persist) return;
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

/* ── Encryption ─────────────────────────────────────────────── */

let key: Buffer | null = null;
function encKey(): Buffer {
  if (key) return key;
  const fromEnv = process.env.SIGNAL_ENCRYPTION_KEY;
  if (fromEnv) {
    key = crypto.createHash('sha256').update(fromEnv).digest();
  } else if (!persist) {
    key = crypto.randomBytes(32);
  } else {
    try {
      key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
    } catch {
      fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      key = crypto.randomBytes(32);
      fs.writeFileSync(KEY_FILE, key.toString('hex'), { mode: 0o600 });
    }
  }
  if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  return key;
}

function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(blob: string): string {
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

/* ── Dashboard password & sessions ──────────────────────────── */

const safeEqual = (a: string, b: string) =>
  crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest());

export function passwordSource(): 'env' | 'ui' | null {
  if (config.adminPassword) return 'env';
  if (s.passwordHash) return 'ui';
  return null;
}

export async function verifyPassword(pw: string): Promise<boolean> {
  if (config.adminPassword) return safeEqual(pw, config.adminPassword);
  if (!s.passwordHash) return false;
  const [alg, salt, hash] = s.passwordHash.split('$');
  if (alg !== 'scrypt') return false;
  const derived = await scrypt(pw, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'base64'), derived);
}

function scrypt(pw: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (err, buf) => (err ? reject(err) : resolve(buf))),
  );
}

export async function setPassword(pw: string): Promise<void> {
  if (config.adminPassword) throw new Error('The password is set by SIGNAL_ADMIN_PASSWORD in .env. Change it there.');
  const salt = crypto.randomBytes(16).toString('base64');
  s.passwordHash = `scrypt$${salt}$${(await scrypt(pw, salt)).toString('base64')}`;
  s.sessionSecret = crypto.randomBytes(32).toString('hex'); // invalidates existing sessions
  save();
}

export function validatePassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 12) throw new Error('Use a password of at least 12 characters.');
  if (pw.length > 256) throw new Error('Password is too long.');
  return pw;
}

let volatileSecret: string | null = null;
export function sessionSecret(): string {
  if (process.env.SIGNAL_SESSION_SECRET) return process.env.SIGNAL_SESSION_SECRET;
  if (!persist) return (volatileSecret ??= crypto.randomBytes(32).toString('hex'));
  if (!s.sessionSecret) {
    s.sessionSecret = crypto.randomBytes(32).toString('hex');
    save();
  }
  return s.sessionSecret;
}

/** One-time code printed to the console on first run, so only someone with server access can claim the dashboard. */
export const setupCode = crypto.randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})/, '$1-');

/* ── Google Workspace ───────────────────────────────────────── */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  client_id?: string;
  project_id?: string;
}

export interface GoogleConnection {
  source: 'ui' | 'env';
  credentials: ServiceAccount;
  adminEmail: string;
  customerId: string;
  scanMail: boolean;
}

export function parseServiceAccount(json: string): ServiceAccount {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('That file is not valid JSON. Upload the key file downloaded from Google Cloud.');
  }
  if (raw.type !== 'service_account') throw new Error('This is not a service account key (expected "type": "service_account").');
  if (typeof raw.client_email !== 'string' || typeof raw.private_key !== 'string' || !raw.private_key.includes('PRIVATE KEY')) {
    throw new Error('The key file is missing client_email or private_key.');
  }
  return {
    client_email: raw.client_email,
    private_key: raw.private_key,
    client_id: typeof raw.client_id === 'string' ? raw.client_id : undefined,
    project_id: typeof raw.project_id === 'string' ? raw.project_id : undefined,
  };
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function googleConnection(): GoogleConnection | null {
  if (s.google) {
    return {
      source: 'ui',
      credentials: JSON.parse(decrypt(s.google.serviceAccount)) as ServiceAccount,
      adminEmail: s.google.adminEmail,
      customerId: s.google.customerId,
      scanMail: s.google.scanMail,
    };
  }
  const g = config.google;
  if (g.keyFile && g.adminEmail && fs.existsSync(g.keyFile)) {
    return { source: 'env', credentials: parseServiceAccount(fs.readFileSync(g.keyFile, 'utf8')), adminEmail: g.adminEmail, customerId: g.customerId, scanMail: g.scanMail };
  }
  return null;
}

export function saveGoogle(input: { serviceAccountJson?: string; adminEmail?: string; customerId?: string; scanMail?: boolean }): void {
  const adminEmail = String(input.adminEmail ?? '').trim().toLowerCase();
  if (!EMAIL.test(adminEmail)) throw new Error('Enter the email address of a Google Workspace super admin.');
  let serviceAccount = s.google?.serviceAccount;
  if (input.serviceAccountJson) serviceAccount = encrypt(JSON.stringify(parseServiceAccount(input.serviceAccountJson)));
  if (!serviceAccount) throw new Error('Upload the service account JSON key.');
  const customerId = String(input.customerId ?? '').trim() || 'my_customer';
  if (!/^[A-Za-z0-9_]+$/.test(customerId)) throw new Error('Customer ID should look like "my_customer" or "C01abc23d".');
  s.google = { serviceAccount, adminEmail, customerId, scanMail: input.scanMail !== false, updatedAt: new Date().toISOString() };
  save();
}

export function removeGoogle(): void {
  delete s.google;
  save();
}

/* ── Microsoft 365 ──────────────────────────────────────────── */

export interface MicrosoftConnection {
  source: 'ui' | 'env';
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scanMail: boolean;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function microsoftConnection(): MicrosoftConnection | null {
  if (s.microsoft) {
    return { source: 'ui', tenantId: s.microsoft.tenantId, clientId: s.microsoft.clientId, clientSecret: decrypt(s.microsoft.clientSecret), scanMail: s.microsoft.scanMail };
  }
  const m = config.microsoft;
  if (m.tenantId && m.clientId && m.clientSecret) return { source: 'env', ...m };
  return null;
}

export function saveMicrosoft(input: { tenantId?: string; clientId?: string; clientSecret?: string; scanMail?: boolean }): void {
  const tenantId = String(input.tenantId ?? '').trim();
  const clientId = String(input.clientId ?? '').trim();
  if (!GUID.test(tenantId) && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(tenantId)) throw new Error('Directory (tenant) ID should be a GUID or a domain such as acme.onmicrosoft.com.');
  if (!GUID.test(clientId)) throw new Error('Application (client) ID should be a GUID.');
  let clientSecret = s.microsoft?.clientSecret;
  const newSecret = String(input.clientSecret ?? '').trim();
  if (newSecret) {
    if (GUID.test(newSecret)) throw new Error('That looks like the Secret ID. Paste the secret Value instead.');
    clientSecret = encrypt(newSecret);
  }
  if (!clientSecret) throw new Error('Paste the client secret value.');
  s.microsoft = { tenantId, clientId, clientSecret, scanMail: input.scanMail !== false, updatedAt: new Date().toISOString() };
  save();
}

export function removeMicrosoft(): void {
  delete s.microsoft;
  save();
}

/* ── Scan settings ──────────────────────────────────────────── */

export function scanSettings() {
  return {
    lookbackDays: s.scan?.lookbackDays ?? config.lookbackDays,
    maxMessagesPerUser: s.scan?.maxMessagesPerUser ?? config.maxMessagesPerUser,
    storeSubjects: s.scan?.storeSubjects ?? config.storeSubjects,
    concurrency: config.concurrency,
  };
}

export function saveScanSettings(input: { lookbackDays?: unknown; maxMessagesPerUser?: unknown; storeSubjects?: unknown }): void {
  const lookbackDays = Number(input.lookbackDays);
  const maxMessagesPerUser = Number(input.maxMessagesPerUser);
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 3650) throw new Error('Lookback must be between 1 and 3650 days.');
  if (!Number.isInteger(maxMessagesPerUser) || maxMessagesPerUser < 10 || maxMessagesPerUser > 10000) throw new Error('Messages per mailbox must be between 10 and 10000.');
  s.scan = { lookbackDays, maxMessagesPerUser, storeSubjects: input.storeSubjects !== false };
  save();
}

export function updatedAt(provider: 'google' | 'microsoft'): string | undefined {
  return s[provider]?.updatedAt;
}
