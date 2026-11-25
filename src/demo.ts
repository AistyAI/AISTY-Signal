/** Fictional acme.com data so anyone can try the dashboard without connecting a tenant. */
import { vendors } from './catalogue.js';
import { replaceAll } from './store.js';
import { hashId } from './util.js';
import { ORG_WIDE, type Evidence, type EvidenceKind, type StoreData } from './types.js';

const people: [string, string, string, string][] = [
  ['mike.chen@acme.com', 'Mike Chen', 'IT', 'Systems Administrator'],
  ['susan.patel@acme.com', 'Susan Patel', 'Accounting', 'Financial Controller'],
  ['jamal.okafor@acme.com', 'Jamal Okafor', 'Engineering', 'Senior Developer'],
  ['lena.fischer@acme.com', 'Lena Fischer', 'Marketing', 'Content Lead'],
  ['tom.walsh@acme.com', 'Tom Walsh', 'Sales', 'Account Executive'],
  ['priya.nair@acme.com', 'Priya Nair', 'Engineering', 'Engineering Manager'],
  ['olivia.brown@acme.com', 'Olivia Brown', 'HR', 'People Partner'],
  ['dan.kowalski@acme.com', 'Dan Kowalski', 'Sales', 'Sales Director'],
  ['amara.diallo@acme.com', 'Amara Diallo', 'Marketing', 'Designer'],
  ['george.evans@acme.com', 'George Evans', 'Legal', 'General Counsel'],
  ['hannah.lee@acme.com', 'Hannah Lee', 'Accounting', 'Accounts Assistant'],
  ['ravi.shah@acme.com', 'Ravi Shah', 'IT', 'Head of IT'],
];

// [email, vendorId, kind, daysAgo, source, detail]
const rows: [string, string, EvidenceKind, number, 'google' | 'microsoft' | 'csv', string][] = [
  ['mike.chen@acme.com', 'chatgpt', 'oauth_grant', 210, 'google', 'OAuth app "ChatGPT" (3 scopes)'],
  ['mike.chen@acme.com', 'chatgpt', 'email_receipt', 12, 'google', 'OpenAI <noreply@tm.openai.com> — Your ChatGPT Plus subscription receipt'],
  ['mike.chen@acme.com', 'perplexity', 'email_signup', 64, 'google', 'Perplexity <team@mail.perplexity.ai> — Welcome to Perplexity'],
  ['susan.patel@acme.com', 'claude', 'email_signup', 140, 'microsoft', 'Anthropic <no-reply@mail.anthropic.com> — Verify your email for Claude'],
  ['susan.patel@acme.com', 'claude', 'email_receipt', 20, 'microsoft', 'Anthropic, PBC <invoice+statements@stripe.com> — Your receipt from Anthropic, PBC'],
  ['jamal.okafor@acme.com', 'cursor', 'email_receipt', 6, 'google', 'Cursor <hi@cursor.com> — Your receipt from Anysphere'],
  ['jamal.okafor@acme.com', 'chatgpt', 'oauth_authorize_event', 95, 'google', 'Authorised "ChatGPT"'],
  ['jamal.okafor@acme.com', 'claude', 'oauth_grant', 44, 'google', 'OAuth app "Claude" (3 scopes)'],
  ['jamal.okafor@acme.com', 'lovable', 'email_signup', 30, 'google', 'Lovable <hello@lovable.dev> — Welcome to Lovable'],
  ['priya.nair@acme.com', 'windsurf', 'email_login', 3, 'google', 'Windsurf <noreply@windsurf.com> — Your sign-in code'],
  ['priya.nair@acme.com', 'chatgpt', 'oauth_grant', 300, 'google', 'OAuth app "ChatGPT" (3 scopes)'],
  ['lena.fischer@acme.com', 'jasper', 'email_receipt', 33, 'microsoft', 'Jasper <billing@jasper.ai> — Invoice for your Jasper subscription'],
  ['lena.fischer@acme.com', 'chatgpt', 'email_signup', 400, 'microsoft', 'OpenAI <noreply@tm.openai.com> — Welcome to ChatGPT'],
  ['lena.fischer@acme.com', 'gamma', 'oauth_grant', 25, 'microsoft', 'Consented to "Gamma" (openid profile email)'],
  ['amara.diallo@acme.com', 'midjourney', 'email_receipt', 15, 'google', 'Midjourney <billing@midjourney.com> — Your Midjourney receipt'],
  ['amara.diallo@acme.com', 'runway', 'email_signup', 80, 'google', 'Runway <hello@runwayml.com> — Welcome to Runway'],
  ['amara.diallo@acme.com', 'elevenlabs', 'email_other', 50, 'google', 'ElevenLabs <team@elevenlabs.io> — What’s new in ElevenLabs'],
  ['tom.walsh@acme.com', 'otter', 'oauth_grant', 120, 'microsoft', 'Consented to "Otter.ai" (Calendars.Read User.Read)'],
  ['tom.walsh@acme.com', 'fireflies', 'email_signup', 9, 'microsoft', 'Fireflies.ai <hello@fireflies.ai> — You’re in! Fred is ready to join your meetings'],
  ['dan.kowalski@acme.com', 'fathom', 'app_assignment', 70, 'microsoft', 'Assigned to "Fathom"'],
  ['dan.kowalski@acme.com', 'chatgpt', 'csv_transaction', 18, 'csv', 'OPENAI *CHATGPT SUBSCR · 20.00'],
  ['olivia.brown@acme.com', 'grammarly', 'email_receipt', 40, 'microsoft', 'Grammarly <billing@grammarly.com> — Your Grammarly Premium receipt'],
  ['george.evans@acme.com', 'harvey', 'email_signup', 22, 'microsoft', 'Harvey <team@harvey.ai> — Invitation to join Harvey'],
  ['george.evans@acme.com', 'claude', 'email_login', 2, 'microsoft', 'Claude <no-reply@mail.anthropic.com> — Your Claude login link'],
  ['hannah.lee@acme.com', 'chatgpt', 'email_login', 1, 'microsoft', 'OpenAI <noreply@tm.openai.com> — Your ChatGPT log-in code'],
  ['ravi.shah@acme.com', 'claude', 'oauth_grant', 15, 'google', 'OAuth app "Claude" (3 scopes)'],
  [ORG_WIDE, 'readai', 'admin_consent', 160, 'microsoft', 'Admin consented "Read AI" for all users (openid User.Read Calendars.Read)'],
];

export function seedDemo(): void {
  const data: StoreData = { version: 1, people: {}, evidence: [], scans: [] };
  for (const [email, name, department, jobTitle] of people) {
    data.people[email] = { email, name, department, jobTitle, sources: [email.length % 2 ? 'google' : 'microsoft'] };
  }
  const now = Date.now();
  data.evidence = rows.map(([userEmail, vendorId, kind, ago, source, detail]): Evidence => {
    const v = vendors.find((x) => x.id === vendorId)!;
    const paid = kind === 'email_receipt' || kind === 'csv_transaction';
    const confidence = kind === 'email_other' ? 'low' : 'high';
    const observedAt = new Date(now - ago * 86_400_000).toISOString();
    return { id: hashId(userEmail, vendorId, kind, detail), userEmail, vendorId, vendorName: v.name, category: v.category, kind, confidence, paid, source, observedAt, detail };
  });
  data.evidence.push({
    id: hashId('demo-unlisted'),
    userEmail: 'tom.walsh@acme.com',
    vendorId: 'unlisted:salesgpt-pro',
    vendorName: 'SalesGPT Pro',
    category: 'Unlisted (name suggests AI)',
    kind: 'oauth_grant',
    confidence: 'low',
    paid: false,
    source: 'microsoft',
    observedAt: new Date(now - 11 * 86_400_000).toISOString(),
    detail: 'Consented to "SalesGPT Pro" (Mail.Read User.Read)',
  });
  data.scans = [
    {
      id: 'demo',
      startedAt: new Date(now - 5 * 60_000).toISOString(),
      finishedAt: new Date(now - 3 * 60_000).toISOString(),
      providers: ['google', 'microsoft'],
      status: 'done',
      warnings: [],
      stats: { google_users: 6, google_mailboxes_scanned: 6, google_messages_matched: 41, microsoft_users: 6, microsoft_ai_apps: 4, microsoft_mailboxes_scanned: 6, evidence: 38, findings: 24 },
    },
  ];
  replaceAll(data);
}
