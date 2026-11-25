/**
 * Google Workspace connector.
 *
 * Uses a service account with domain-wide delegation:
 *   - impersonates a super admin for Directory (users, OAuth tokens) and Reports (token audit log)
 *   - impersonates each user for a Gmail search of AI vendor sender domains (metadata only)
 *
 * Connected from the dashboard (Connections → Google Workspace) or via .env.
 * Required scopes (authorise these in Admin console → Security → API controls → Domain-wide delegation):
 *   https://www.googleapis.com/auth/admin.directory.user.readonly
 *   https://www.googleapis.com/auth/admin.directory.user.security
 *   https://www.googleapis.com/auth/admin.reports.audit.readonly
 *   https://www.googleapis.com/auth/gmail.readonly   (only if mailbox scanning is on)
 */
import { JWT } from 'google-auth-library';
import { chunkDomains, looksLikeAi, searchDomains, unlistedVendorId, vendorForAppName } from '../catalogue.js';
import { classifyEmail } from '../classify.js';
import { googleConnection, type GoogleConnection } from '../settings.js';
import { daysAgo, errorMessage, pool, truncate } from '../util.js';
import type { ScanContext } from '../types.js';

const ADMIN_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
  'https://www.googleapis.com/auth/admin.directory.user.security',
  'https://www.googleapis.com/auth/admin.reports.audit.readonly',
];
const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
/** Shown in the connect wizard so admins can paste them into Domain-wide delegation. */
export const GOOGLE_SCOPES = { admin: ADMIN_SCOPES, mail: GMAIL_SCOPES };
const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1';
const REPORTS = 'https://admin.googleapis.com/admin/reports/v1';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1';

function client(conn: GoogleConnection, subject: string, scopes: string[]): JWT {
  return new JWT({ email: conn.credentials.client_email, key: conn.credentials.private_key, scopes, subject });
}

function requireConnection(): GoogleConnection {
  const conn = googleConnection();
  if (!conn) throw new Error('Google Workspace is not connected');
  return conn;
}

async function get<T>(c: JWT, url: string, params: Record<string, string | number | string[] | undefined> = {}): Promise<T> {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) u.searchParams.append(k, String(item));
  }
  const res = await c.request<T>({ url: u.toString(), retry: true });
  return res.data;
}

function googleError(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { error?: { message?: string } | string; error_description?: string } } };
  const d = e.response?.data;
  const msg = (typeof d?.error === 'object' ? d.error.message : d?.error_description ?? d?.error) ?? errorMessage(err);
  const text = e.response?.status ? `${e.response.status}: ${msg}` : String(msg);
  return text + googleHint(text);
}

/** Translate Google's terse auth errors into what to actually fix. */
function googleHint(text: string): string {
  if (/unauthorized_client|Client is unauthorized/i.test(text))
    return ' — Domain-wide delegation is not authorised for this Client ID and these scopes yet (it can take a few minutes after saving in the Admin console).';
  if (/invalid_grant|Invalid JWT|Not a valid email or user ID/i.test(text))
    return ' — Check the super admin email is a real user in your Workspace, and that the key belongs to an active service account.';
  if (/Not Authorized to access this resource|insufficient permissions|forbidden/i.test(text))
    return ' — The admin email must be a super admin, and the Admin SDK API must be enabled in the Cloud project.';
  if (/has not been used in project|is disabled/i.test(text)) return ' — Enable the API in Google Cloud Console (step 1), wait a minute, then test again.';
  return '';
}

interface GUser {
  primaryEmail: string;
  name?: { fullName?: string };
  suspended?: boolean;
  orgUnitPath?: string;
  organizations?: { department?: string; title?: string; primary?: boolean }[];
}

async function listUsers(admin: JWT, customerId: string): Promise<GUser[]> {
  const users: GUser[] = [];
  let pageToken: string | undefined;
  do {
    const page = await get<{ users?: GUser[]; nextPageToken?: string }>(admin, `${DIRECTORY}/users`, {
      customer: customerId,
      maxResults: 500,
      pageToken,
    });
    users.push(...(page.users ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return users;
}

export async function testGoogle(): Promise<string> {
  const conn = requireConnection();
  const admin = client(conn, conn.adminEmail, ADMIN_SCOPES);
  const page = await get<{ users?: GUser[] }>(admin, `${DIRECTORY}/users`, { customer: conn.customerId, maxResults: 1 }).catch(
    (err) => {
      throw new Error(googleError(err));
    },
  );
  let mail = 'mail scan disabled';
  if (conn.scanMail) {
    await get(client(conn, conn.adminEmail, GMAIL_SCOPES), `${GMAIL}/users/me/profile`).catch((err) => {
      throw new Error(`Directory OK, but Gmail access failed: ${googleError(err)}`);
    });
    mail = 'Gmail access OK';
  }
  return `Connected as ${conn.credentials.client_email}. Directory OK (${page.users?.length ? 'users visible' : 'no users returned'}), ${mail}.`;
}

export async function scanGoogle(ctx: ScanContext): Promise<void> {
  const conn = requireConnection();
  const admin = client(conn, conn.adminEmail, ADMIN_SCOPES);

  ctx.progress('Google: listing users');
  let users: GUser[];
  try {
    users = await listUsers(admin, conn.customerId);
  } catch (err) {
    throw new Error(`Google: could not list users (${googleError(err)})`);
  }
  const active = users.filter((u) => !u.suspended);
  for (const u of users) {
    const org = u.organizations?.find((o) => o.primary) ?? u.organizations?.[0];
    ctx.addPerson(
      {
        email: u.primaryEmail.toLowerCase(),
        name: u.name?.fullName,
        department: org?.department || (u.orgUnitPath && u.orgUnitPath !== '/' ? u.orgUnitPath.replace(/^\//, '') : undefined),
        jobTitle: org?.title,
      },
      'google',
    );
  }
  ctx.bump('google_users', users.length);

  // 1. Current OAuth / "Sign in with Google" grants, per user.
  ctx.progress(`Google: checking sign-in grants for ${active.length} users`);
  await pool(active, ctx.concurrency, async (u) => {
    try {
      const res = await get<{ items?: { clientId: string; displayText?: string; scopes?: string[] }[] }>(
        admin,
        `${DIRECTORY}/users/${encodeURIComponent(u.primaryEmail)}/tokens`,
      );
      for (const t of res.items ?? []) {
        const name = t.displayText ?? t.clientId;
        const vendor = vendorForAppName(name);
        if (!vendor && !looksLikeAi(name)) continue;
        ctx.addEvidence({
          userEmail: u.primaryEmail.toLowerCase(),
          vendorId: vendor?.id ?? unlistedVendorId(name),
          vendorName: vendor?.name ?? name,
          category: vendor?.category ?? 'Unlisted (name suggests AI)',
          kind: 'oauth_grant',
          confidence: vendor ? 'high' : 'low',
          paid: false,
          source: 'google',
          detail: `OAuth app "${name}" (${(t.scopes ?? []).length} scopes)`,
        });
      }
    } catch (err) {
      ctx.warn(`Google: tokens for ${u.primaryEmail}: ${googleError(err)}`);
    }
  });

  // 2. Token audit log: catches grants that were later revoked (Google keeps ~180 days).
  ctx.progress('Google: reading token audit log');
  try {
    const start = daysAgo(Math.min(ctx.lookbackDays, 179)).toISOString();
    let pageToken: string | undefined;
    let pages = 0;
    do {
      const res = await get<{
        items?: { id: { time: string }; actor?: { email?: string }; events?: { name: string; parameters?: { name: string; value?: string }[] }[] }[];
        nextPageToken?: string;
      }>(admin, `${REPORTS}/activity/users/all/applications/token`, { eventName: 'authorize', startTime: start, maxResults: 1000, pageToken });
      for (const item of res.items ?? []) {
        const email = item.actor?.email?.toLowerCase();
        if (!email) continue;
        for (const ev of item.events ?? []) {
          const appName = ev.parameters?.find((p) => p.name === 'app_name')?.value;
          const vendor = vendorForAppName(appName);
          if (!vendor) continue;
          ctx.addEvidence({
            userEmail: email,
            vendorId: vendor.id,
            vendorName: vendor.name,
            category: vendor.category,
            kind: 'oauth_authorize_event',
            confidence: 'high',
            paid: false,
            source: 'google',
            observedAt: item.id.time,
            detail: `Authorised "${appName}"`,
          });
        }
      }
      pageToken = res.nextPageToken;
    } while (pageToken && ++pages < 50);
  } catch (err) {
    ctx.warn(`Google: token audit log unavailable (${googleError(err)})`);
  }

  // 3. Mailbox signals: welcome, login and receipt mail from AI vendors (headers only).
  if (!conn.scanMail) return;
  const chunks = chunkDomains(searchDomains());
  const queries = chunks.map((c) => `from:(${c.join(' OR ')}) newer_than:${ctx.lookbackDays}d in:anywhere`);
  ctx.progress(`Google: scanning ${active.length} mailboxes`);
  let done = 0;
  await pool(active, ctx.concurrency, async (u) => {
    const email = u.primaryEmail.toLowerCase();
    try {
      const gmail = client(conn, email, GMAIL_SCOPES);
      const ids = new Set<string>();
      for (const q of queries) {
        let pageToken: string | undefined;
        do {
          const res = await get<{ messages?: { id: string }[]; nextPageToken?: string }>(gmail, `${GMAIL}/users/me/messages`, {
            q,
            maxResults: 100,
            pageToken,
          });
          for (const m of res.messages ?? []) ids.add(m.id);
          pageToken = ids.size < ctx.maxMessagesPerUser ? res.nextPageToken : undefined;
        } while (pageToken);
      }
      const list = [...ids].slice(0, ctx.maxMessagesPerUser);
      for (const id of list) {
        const msg = await get<{ internalDate?: string; payload?: { headers?: { name: string; value: string }[] } }>(
          gmail,
          `${GMAIL}/users/me/messages/${id}`,
          { format: 'metadata', metadataHeaders: ['From', 'Subject'] },
        );
        const h = (n: string) => msg.payload?.headers?.find((x) => x.name.toLowerCase() === n.toLowerCase())?.value;
        const from = h('From');
        const subject = h('Subject');
        const c = classifyEmail(from, subject);
        if (!c) continue;
        ctx.addEvidence({
          userEmail: email,
          vendorId: c.vendor.id,
          vendorName: c.vendor.name,
          category: c.vendor.category,
          kind: c.kind,
          confidence: c.confidence,
          paid: c.paid,
          source: 'google',
          observedAt: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : undefined,
          detail: truncate(ctx.storeSubjects ? `${from} — ${subject ?? ''}` : `${from}`, 200),
        });
      }
      ctx.bump('google_messages_matched', list.length);
      ctx.bump('google_mailboxes_scanned');
    } catch (err) {
      const msg = googleError(err);
      if (/failedPrecondition|Mail service not enabled|not.*enabled/i.test(msg)) ctx.bump('google_mailboxes_skipped');
      else ctx.warn(`Google: mailbox ${email}: ${msg}`);
    }
    if (++done % 10 === 0) ctx.progress(`Google: scanned ${done}/${active.length} mailboxes`);
  });
}
