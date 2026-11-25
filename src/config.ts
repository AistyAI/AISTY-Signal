import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;

// The project was originally called FindAI: keep honouring FINDAI_* variables from older .env files.
for (const [k, v] of Object.entries(env)) {
  if (k.startsWith('FINDAI_') && env['SIGNAL_' + k.slice(7)] === undefined) env['SIGNAL_' + k.slice(7)] = v;
}

/**
 * Environment configuration. Connections and scan settings can also be managed in the UI
 * (see settings.ts), which takes precedence over these values.
 */

/** Project root: one level above src/ (dev) or dist/ (built). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function int(name: string, fallback: number): number {
  const n = Number.parseInt(env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  host: env.HOST || '127.0.0.1',
  port: int('PORT', 3000),
  demo: env.SIGNAL_DEMO === 'true',
  adminPassword: env.SIGNAL_ADMIN_PASSWORD ?? '',
  dataDir: path.resolve(ROOT, env.SIGNAL_DATA_DIR || 'data'),
  lookbackDays: int('SCAN_LOOKBACK_DAYS', 365),
  maxMessagesPerUser: int('SCAN_MAX_MESSAGES_PER_USER', 500),
  concurrency: int('SCAN_CONCURRENCY', 5),
  storeSubjects: env.SIGNAL_STORE_SUBJECTS !== 'false',
  google: {
    keyFile: env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE ? path.resolve(ROOT, env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE) : '',
    adminEmail: env.GOOGLE_ADMIN_EMAIL ?? '',
    customerId: env.GOOGLE_CUSTOMER_ID || 'my_customer',
    scanMail: env.GOOGLE_SCAN_MAIL !== 'false',
  },
  microsoft: {
    tenantId: env.MS_TENANT_ID ?? '',
    clientId: env.MS_CLIENT_ID ?? '',
    clientSecret: env.MS_CLIENT_SECRET ?? '',
    scanMail: env.MS_SCAN_MAIL !== 'false',
  },
  aisty: {
    url: 'https://www.aisty.ai/?utm_source=aisty-signal&utm_medium=oss&utm_campaign=aisty-signal',
    bookUrl: 'https://www.aisty.ai/book/?utm_source=aisty-signal&utm_medium=oss&utm_campaign=aisty-signal',
  },
};
