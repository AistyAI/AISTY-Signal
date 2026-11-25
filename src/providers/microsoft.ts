/**
 * Microsoft 365 / Entra ID connector (Microsoft Graph, app-only / client credentials).
 *
 * Application permissions (grant admin consent):
 *   User.Read.All                     – list people, departments
 *   Application.Read.All              – third-party enterprise apps (service principals) + assignments
 *   DelegatedPermissionGrant.Read.All – which users consented to which app ("Sign in with Microsoft")
 *   Mail.ReadBasic.All                – sender/subject/date only, never bodies (only if mailbox scanning is on)
 */
import { chunkDomains, looksLikeAi, searchDomains, unlistedVendorId, vendorForAppName, type Vendor } from '../catalogue.js';
import { classifyEmail } from '../classify.js';
import { microsoftConnection, type MicrosoftConnection } from '../settings.js';
import { daysAgo, errorMessage, pool, sleep, truncate } from '../util.js';
import { ORG_WIDE, type ScanContext } from '../types.js';

/** Graph application permissions, shown in the connect wizard. */
export const MICROSOFT_PERMISSIONS = [
  { name: 'User.Read.All', why: 'Names, departments and job titles', mail: false },
  { name: 'Application.Read.All', why: 'Third-party enterprise apps and who is assigned to them', mail: false },
  { name: 'DelegatedPermissionGrant.Read.All', why: 'Which users signed in to which app with Microsoft', mail: false },
  { name: 'Mail.ReadBasic.All', why: 'Sender, subject and date only: cannot read bodies or attachments', mail: true },
];

const GRAPH = 'https://graph.microsoft.com/v1.0';

let token: { value: string; expires: number; for: string } | null = null;
let current: MicrosoftConnection | null = null;

function requireConnection(): MicrosoftConnection {
  const conn = microsoftConnection();
  if (!conn) throw new Error('Microsoft 365 is not connected');
  current = conn;
  return conn;
}

async function accessToken(): Promise<string> {
  if (!current) throw new Error('Microsoft 365 is not connected');
  const { tenantId, clientId, clientSecret } = current;
  const cacheKey = `${tenantId}|${clientId}|${clientSecret}`;
  if (token && token.for === cacheKey && token.expires > Date.now() + 60_000) return token.value;
  const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`Microsoft sign-in failed: ${body.error_description?.split('\r\n')[0] ?? res.status}`);
  token = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000, for: cacheKey };
  return token.value;
}

export class GraphError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(`${status} ${code}: ${message}`);
  }
}

async function graph<T>(url: string, attempt = 0): Promise<T> {
  const res = await fetch(url.startsWith('http') ? url : GRAPH + url, {
    headers: { authorization: `Bearer ${await accessToken()}`, accept: 'application/json' },
  });
  if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 5) {
    const wait = Number(res.headers.get('retry-after')) || 2 ** attempt;
    await sleep(Math.min(wait, 60) * 1000);
    return graph<T>(url, attempt + 1);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    throw new GraphError(res.status, body.error?.code ?? 'error', body.error?.message ?? res.statusText);
  }
  return (await res.json()) as T;
}

async function graphAll<T>(url: string, maxItems = Infinity): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  while (next && out.length < maxItems) {
    const page: { value: T[]; '@odata.nextLink'?: string } = await graph(next);
    out.push(...page.value);
    next = page['@odata.nextLink'];
  }
  return out;
}

interface MsUser {
  id: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName: string;
  department?: string | null;
  jobTitle?: string | null;
  accountEnabled?: boolean;
}

interface ServicePrincipal {
  id: string;
  appId: string;
  displayName: string;
  appOwnerOrganizationId?: string | null;
  publisherName?: string | null;
  verifiedPublisher?: { displayName?: string | null } | null;
  servicePrincipalType?: string;
  createdDateTime?: string | null;
}

export async function testMicrosoft(): Promise<string> {
  const conn = requireConnection();
  await accessToken();
  const org = await graph<{ value: { displayName: string }[] }>('/organization?$select=displayName').catch(() => null);
  await graph('/users?$top=1&$select=id');
  await graph('/servicePrincipals?$top=1&$select=id');
  return `Connected to ${org?.value[0]?.displayName ?? 'tenant'}. Users and enterprise apps readable${conn.scanMail ? '; mailbox access is checked during the scan' : ''}.`;
}

export async function scanMicrosoft(ctx: ScanContext): Promise<void> {
  const conn = requireConnection();
  ctx.progress('Microsoft: signing in');
  const org = await graph<{ value: { id: string }[] }>('/organization?$select=id');
  const tenantId = org.value[0]?.id;

  ctx.progress('Microsoft: listing users');
  const users = await graphAll<MsUser>('/users?$select=id,displayName,mail,userPrincipalName,department,jobTitle,accountEnabled&$top=999');
  const byId = new Map<string, MsUser>();
  const emailOf = (u: MsUser) => (u.mail || u.userPrincipalName).toLowerCase();
  for (const u of users) {
    byId.set(u.id, u);
    ctx.addPerson({ email: emailOf(u), name: u.displayName, department: u.department ?? undefined, jobTitle: u.jobTitle ?? undefined }, 'microsoft');
  }
  ctx.bump('microsoft_users', users.length);

  // 1. Third-party enterprise apps that are AI tools.
  ctx.progress('Microsoft: checking enterprise apps');
  const sps = await graphAll<ServicePrincipal>(
    '/servicePrincipals?$select=id,appId,displayName,appOwnerOrganizationId,publisherName,verifiedPublisher,servicePrincipalType,createdDateTime&$top=999',
  );
  const thirdParty = sps.filter(
    (sp) =>
      sp.servicePrincipalType === 'Application' &&
      sp.appOwnerOrganizationId &&
      sp.appOwnerOrganizationId !== tenantId &&
      // Microsoft's own first-party apps live in these tenants.
      !['f8cdef31-a31e-4b4a-93e4-5f571e91255a', '72f988bf-86f1-41af-91ab-2d7cd011db47'].includes(sp.appOwnerOrganizationId),
  );
  const aiApps: { sp: ServicePrincipal; vendor?: Vendor }[] = [];
  for (const sp of thirdParty) {
    const vendor = vendorForAppName(sp.displayName, sp.verifiedPublisher?.displayName ?? undefined, sp.publisherName ?? undefined);
    if (vendor || looksLikeAi(sp.displayName)) aiApps.push({ sp, vendor });
  }
  ctx.bump('microsoft_ai_apps', aiApps.length);

  await pool(aiApps, ctx.concurrency, async ({ sp, vendor }) => {
    const base = {
      vendorId: vendor?.id ?? unlistedVendorId(sp.displayName),
      vendorName: vendor?.name ?? sp.displayName,
      category: vendor?.category ?? 'Unlisted (name suggests AI)',
      confidence: vendor ? ('high' as const) : ('low' as const),
      paid: false,
      source: 'microsoft' as const,
      observedAt: sp.createdDateTime ?? undefined,
    };
    try {
      const grants = await graphAll<{ consentType: string; principalId?: string | null; scope?: string }>(
        `/oauth2PermissionGrants?$filter=clientId eq '${sp.id}'`,
      );
      for (const g of grants) {
        if (g.consentType === 'AllPrincipals') {
          ctx.addEvidence({ ...base, userEmail: ORG_WIDE, kind: 'admin_consent', detail: `Admin consented "${sp.displayName}" for all users (${g.scope?.trim() ?? ''})` });
        } else if (g.principalId) {
          const u = byId.get(g.principalId);
          if (!u) continue;
          ctx.addEvidence({ ...base, userEmail: emailOf(u), kind: 'oauth_grant', detail: `Consented to "${sp.displayName}" (${g.scope?.trim() ?? ''})` });
        }
      }
      const assignments = await graphAll<{ principalId: string; principalType: string; principalDisplayName?: string; createdDateTime?: string }>(
        `/servicePrincipals/${sp.id}/appRoleAssignedTo`,
      );
      for (const a of assignments) {
        if (a.principalType === 'User') {
          const u = byId.get(a.principalId);
          if (!u) continue;
          ctx.addEvidence({ ...base, userEmail: emailOf(u), kind: 'app_assignment', observedAt: a.createdDateTime ?? base.observedAt, detail: `Assigned to "${sp.displayName}"` });
        } else {
          ctx.addEvidence({ ...base, userEmail: ORG_WIDE, kind: 'app_assignment', detail: `${a.principalType} "${a.principalDisplayName ?? a.principalId}" assigned to "${sp.displayName}"` });
        }
      }
    } catch (err) {
      ctx.warn(`Microsoft: app "${sp.displayName}": ${errorMessage(err)}`);
    }
  });

  // 2. Mailbox signals (Mail.ReadBasic.All: sender, subject, date — no bodies).
  if (!conn.scanMail) return;
  const mailUsers = users.filter((u) => u.accountEnabled !== false && u.mail);
  const cutoff = daysAgo(ctx.lookbackDays).toISOString();
  const searches = chunkDomains(searchDomains(), 450).map((c) => c.map((d) => `from:${d}`).join(' OR '));
  ctx.progress(`Microsoft: scanning ${mailUsers.length} mailboxes`);
  let done = 0;
  let permissionWarned = false;
  await pool(mailUsers, ctx.concurrency, async (u) => {
    const email = emailOf(u);
    try {
      let count = 0;
      for (const s of searches) {
        if (count >= ctx.maxMessagesPerUser) break;
        const url = `/users/${u.id}/messages?$search=${encodeURIComponent(`"${s}"`)}&$select=from,subject,receivedDateTime&$top=100`;
        const msgs = await graphAll<{ from?: { emailAddress?: { name?: string; address?: string } }; subject?: string; receivedDateTime?: string }>(
          url,
          ctx.maxMessagesPerUser - count,
        );
        count += msgs.length;
        for (const m of msgs) {
          if (m.receivedDateTime && m.receivedDateTime < cutoff) continue;
          const addr = m.from?.emailAddress;
          const from = addr?.address ? `${addr.name ?? ''} <${addr.address}>` : undefined;
          const c = classifyEmail(from, m.subject);
          if (!c) continue;
          ctx.addEvidence({
            userEmail: email,
            vendorId: c.vendor.id,
            vendorName: c.vendor.name,
            category: c.vendor.category,
            kind: c.kind,
            confidence: c.confidence,
            paid: c.paid,
            source: 'microsoft',
            observedAt: m.receivedDateTime,
            detail: truncate(ctx.storeSubjects ? `${from} — ${m.subject ?? ''}` : `${from}`, 200),
          });
        }
      }
      ctx.bump('microsoft_mailboxes_scanned');
    } catch (err) {
      if (err instanceof GraphError && (err.code === 'MailboxNotEnabledForRESTAPI' || err.code === 'ResourceNotFound' || err.status === 404)) {
        ctx.bump('microsoft_mailboxes_skipped');
      } else if (err instanceof GraphError && err.status === 403) {
        if (!permissionWarned) ctx.warn(`Microsoft: mailbox access denied (${err.message}). Check Mail.ReadBasic.All has admin consent and no application access policy excludes these mailboxes.`);
        permissionWarned = true;
        ctx.bump('microsoft_mailboxes_denied');
      } else {
        ctx.warn(`Microsoft: mailbox ${email}: ${errorMessage(err)}`);
      }
    }
    if (++done % 10 === 0) ctx.progress(`Microsoft: scanned ${done}/${mailUsers.length} mailboxes`);
  });
}
