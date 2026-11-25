// Aisty Signal: dashboard. Plain JS, no build step.
// Everything rendered from the API is escaped: email subjects are attacker-controlled text.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const RANK = { low: 0, medium: 1, high: 2 };
const PSEUDO = (e) => e === '(organisation-wide)' || e === '(unattributed)' || e.startsWith('group:');
const cap = (v) => {
  const t = String(v ?? '');
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const PROVIDER_NAMES = { google: 'Google Workspace', microsoft: 'Microsoft 365', csv: 'CSV import', demo: 'Demo' };
const providerName = (p) => PROVIDER_NAMES[p] || cap(p);
const SCAN_STATUS = { running: 'Running', done: 'Complete', failed: 'Failed' };
const STAT_LABELS = {
  google_users: 'Google Workspace users',
  google_mailboxes_scanned: 'Gmail mailboxes scanned',
  google_mailboxes_skipped: 'Gmail mailboxes skipped (no licence)',
  google_messages_matched: 'Gmail messages checked',
  microsoft_users: 'Microsoft 365 users',
  microsoft_ai_apps: 'AI enterprise apps found',
  microsoft_mailboxes_scanned: 'Outlook mailboxes scanned',
  microsoft_mailboxes_skipped: 'Outlook mailboxes skipped (no mailbox)',
  microsoft_mailboxes_denied: 'Outlook mailboxes denied',
  evidence: 'Evidence records',
  findings: 'Findings',
};
const statLabel = (k) => STAT_LABELS[k] || cap(k.replace(/_/g, ' '));
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: { 'x-signal': '1', ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
    credentials: 'same-origin',
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && !['/login', '/session', '/setup', '/password'].includes(path)) {
    body.error === 'Setup required' ? showSetup() : showLogin();
    throw new Error('Not signed in');
  }
  if (!res.ok) throw Object.assign(new Error(body.error || body.message || res.statusText), { body });
  return body;
}

let state = { findings: [], summary: null, people: [], labels: {}, status: null };
let pollTimer = null;

/* ── Boot ─────────────────────────────────────────────────── */

async function boot() {
  fetch('/aisty-logo.svg')
    .then((r) => r.text())
    .then((svg) => {
      // Our own static asset, inlined so it inherits currentColor for dark mode.
      if (svg.trim().startsWith('<svg')) $$('[data-logo]').forEach((el) => (el.innerHTML = svg));
    })
    .catch(() => {});

  const session = await api('/session');
  $$('[data-aisty-link]').forEach((a) => (a.href = session.aisty.url));
  $$('[data-aisty-book]').forEach((a) => (a.href = session.aisty.bookUrl));
  $('#demo-banner').hidden = !session.demo;
  showConsentResult();
  if (session.needsSetup) showSetup();
  else if (session.authenticated) showApp(session.demo);
  else showLogin();
}

function showOnly(id) {
  for (const v of ['#login-view', '#setup-view', '#app-view']) $(v).hidden = v !== id;
}

function showLogin() {
  showOnly('#login-view');
  $('#logout').hidden = true;
  $('#password').focus();
}

function showSetup() {
  showOnly('#setup-view');
  $('#logout').hidden = true;
  $('#setup-code').focus();
}

async function showApp(demo) {
  showOnly('#app-view');
  $('#logout').hidden = !!demo;
  await refresh();
  // Deep links: /#connect-google and /#connect-microsoft open the wizard directly.
  const h = location.hash.slice(1);
  if (h === 'connect-google' || h === 'connect-microsoft') {
    selectTab('connections');
    (h === 'connect-google' ? openGoogleWizard : openMicrosoftWizard)();
  }
}

$('#setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#setup-error');
  err.textContent = '';
  if ($('#setup-pw').value !== $('#setup-pw2').value) {
    err.textContent = 'The passwords do not match.';
    return;
  }
  try {
    await api('/setup', { method: 'POST', body: JSON.stringify({ setupCode: $('#setup-code').value, password: $('#setup-pw').value }) });
    $('#setup-form').reset();
    await showApp(false);
    selectTab('connections');
  } catch (ex) {
    err.textContent = ex.message;
  }
});

/** Microsoft's admin-consent page redirects back with ?ms_consent=ok|error. */
function showConsentResult() {
  const q = new URLSearchParams(location.search);
  const result = q.get('ms_consent');
  if (!result) return;
  const n = $('#consent-notice');
  n.hidden = false;
  n.className = 'notice ' + (result === 'ok' ? 'good' : 'bad');
  n.textContent =
    result === 'ok'
      ? 'Microsoft 365 admin consent granted. Click "Test connection" to confirm Aisty Signal can read your tenant.'
      : `Microsoft 365 admin consent was not granted: ${q.get('message') || 'unknown error'}`;
  history.replaceState(null, '', location.pathname + '#connections');
  selectTab('connections');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/login', { method: 'POST', body: JSON.stringify({ password: $('#password').value }) });
    $('#password').value = '';
    showApp(false);
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

/* ── Data ─────────────────────────────────────────────────── */

async function refresh() {
  const [status, data] = await Promise.all([api('/status'), api('/findings')]);
  state = { ...state, ...data, status };
  renderAll();
  if (status.scan.running) startPolling();
}

function renderAll() {
  renderHeadline();
  renderStats();
  renderBars();
  renderAttention();
  renderPeopleFilters();
  renderPeople();
  renderTools();
  renderEvidence();
  renderConnections();
  renderScanStatus();
}

/* ── Overview ─────────────────────────────────────────────── */

function renderHeadline() {
  const s = state.summary;
  if (!s || !state.findings.length) {
    $('#headline').innerHTML = 'Which AI tools has your organisation signed up for?';
    const c = state.status?.connections;
    const configured = c && (c.google.connected || c.microsoft.connected);
    $('#subhead').textContent = configured
      ? 'Run a scan to check sign-in grants, audit logs and the account emails AI vendors send to company addresses.'
      : 'Start by connecting Google Workspace or Microsoft 365 in the Connections tab, then run a scan.';
    return;
  }
  const people = s.peopleWithAi === 1 ? '1 person is' : `${s.peopleWithAi} people are`;
  const tools = s.tools === 1 ? '1 AI tool' : `${s.tools} AI tools`;
  $('#headline').innerHTML = `<em>${esc(people)}</em> using ${esc(tools)} with company accounts`;
  const last = state.status?.lastScan?.finishedAt;
  $('#subhead').textContent = `Based on sign-in grants, audit logs and vendor emails${last ? `, last scanned ${fmtDate(last)}` : ''}. Aisty Signal shows evidence of an account, not proof of current use.`;
}

function renderStats() {
  const s = state.summary || {};
  const pct = s.directorySize ? Math.round((s.peopleWithAi / s.directorySize) * 100) : null;
  const tiles = [
    ['People using AI', s.peopleWithAi ?? 0, pct !== null ? `${pct}% of ${s.directorySize} in directory` : 'across scanned accounts'],
    ['AI tools found', s.tools ?? 0, `${state.status?.catalogueSize ?? '—'} tools in catalogue`],
    ['Paid subscriptions', s.paidSubscriptions ?? 0, 'receipts and card transactions'],
    ['Org-wide consents', s.orgWideConsents ?? 0, 'apps approved for everyone'],
  ];
  $('#stats').innerHTML = tiles
    .map(
      ([label, value, note]) =>
        `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div><div class="stat-note">${esc(note)}</div></div>`,
    )
    .join('');
}

function barList(el, rows, unit) {
  if (!rows.length) {
    el.innerHTML = '<p class="empty">No data yet</p>';
    return;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);
  el.innerHTML = rows
    .map(
      (r) => `<div class="bar-row" data-tip="${esc(`${r.label}: ${r.value} ${r.value === 1 ? unit[0] : unit[1]}${r.extra ? ` · ${r.extra}` : ''}`)}">
        <span class="bar-label" title="${esc(r.label)}">${esc(r.label)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(r.value / max) * 100}%"></span></span>
        <span class="bar-value">${esc(r.value)}</span></div>`,
    )
    .join('');
}

function renderBars() {
  const s = state.summary || { byVendor: [], byDepartment: [] };
  const vendors = s.byVendor.filter((v) => v.users > 0);
  const top = vendors.slice(0, 10).map((v) => ({ label: v.vendorName, value: v.users, extra: v.paid ? `${v.paid} paid` : '' }));
  if (vendors.length > 10) {
    const rest = vendors.slice(10);
    top.push({ label: `${rest.length} other tools`, value: rest.reduce((n, v) => n + v.users, 0), extra: 'combined' });
  }
  barList($('#tool-bars'), top, ['person', 'people']);
  barList(
    $('#dept-bars'),
    s.byDepartment.map((d) => ({ label: d.department, value: d.users })),
    ['person', 'people'],
  );
}

function renderAttention() {
  const items = [];
  const f = state.findings;
  const orgWide = f.filter((x) => x.userEmail === '(organisation-wide)');
  for (const o of orgWide)
    items.push(['bad', 'Org-wide', `<strong>${esc(o.vendorName)}</strong> has admin consent or a group assignment covering many users.`]);
  const unlisted = f.filter((x) => x.vendorId.startsWith('unlisted:'));
  for (const u of unlisted)
    items.push(['warn', 'Unlisted', `<strong>${esc(u.vendorName)}</strong> looks like an AI app but isn't in the catalogue. Review the access it holds.`]);
  const paidByVendor = new Map();
  for (const x of f.filter((x) => x.paid)) paidByVendor.set(x.vendorName, (paidByVendor.get(x.vendorName) || 0) + 1);
  for (const [name, n] of [...paidByVendor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4))
    items.push(['warn', 'Spend', `<strong>${esc(n)}</strong> individual paid ${esc(name)} ${n === 1 ? 'subscription' : 'subscriptions'}. Consider consolidating.`]);
  const unattributed = f.filter((x) => x.userEmail === '(unattributed)');
  if (unattributed.length) items.push(['warn', 'Unmatched', `${esc(unattributed.length)} card transactions couldn't be matched to a person.`]);
  const warnings = state.status?.lastScan?.warnings?.length || 0;
  if (warnings) items.push(['warn', 'Scan', `The last scan reported ${esc(warnings)} warnings. See the Connections tab.`]);
  $('#attention').innerHTML = items.length
    ? items.map(([sev, tag, html]) => `<li><span class="sev ${sev}">${esc(tag)}</span><span>${html}</span></li>`).join('')
    : '<li class="muted">Nothing flagged yet.</li>';
}

/* ── People ───────────────────────────────────────────────── */

function renderPeopleFilters() {
  const sel = $('#people-dept');
  const cur = sel.value;
  const depts = [...new Set(state.findings.map((f) => f.department || 'Unknown'))].sort();
  sel.innerHTML = '<option value="">All departments</option>' + depts.map((d) => `<option>${esc(d)}</option>`).join('');
  sel.value = depts.includes(cur) ? cur : '';
}

function peopleRows() {
  const q = $('#people-search').value.trim().toLowerCase();
  const dept = $('#people-dept').value;
  const min = RANK[$('#people-conf').value];
  const byUser = new Map();
  for (const f of state.findings) {
    if (RANK[f.confidence] < min) continue;
    if (dept && (f.department || 'Unknown') !== dept) continue;
    const row = byUser.get(f.userEmail) || { email: f.userEmail, name: f.name, department: f.department, jobTitle: f.jobTitle, tools: [] };
    row.tools.push(f);
    byUser.set(f.userEmail, row);
  }
  return [...byUser.values()]
    .filter((r) => !q || [r.email, r.name, r.department, ...r.tools.map((t) => t.vendorName)].some((s) => s && s.toLowerCase().includes(q)))
    .sort((a, b) => PSEUDO(a.email) - PSEUDO(b.email) || b.tools.length - a.tools.length || (a.name || a.email).localeCompare(b.name || b.email));
}

const chip = (f) =>
  `<span class="chip${f.paid ? ' paid' : ''}" title="${esc(`${f.vendorName} · ${cap(f.confidence)} confidence${f.paid ? ' · Paid' : ''}`)}"><span class="dot ${f.confidence}"></span>${esc(f.vendorName)}${f.paid ? ' · Paid' : ''}</span>`;

function renderPeople() {
  const rows = peopleRows();
  $('#people-empty').hidden = rows.length > 0;
  $('#people-body').innerHTML = rows
    .map(
      (r) => `<tr tabindex="0" data-person="${esc(r.email)}">
        <td><div class="person-name">${esc(r.name || r.email)}</div>${r.name ? `<div class="person-email">${esc(r.email)}</div>` : ''}${r.jobTitle ? `<div class="person-email">${esc(r.jobTitle)}</div>` : ''}</td>
        <td>${esc(r.department || '—')}</td>
        <td><div class="chips">${r.tools.map(chip).join('')}</div></td>
        <td class="num">${esc(r.tools.length)}</td></tr>`,
    )
    .join('');
}

['#people-search', '#people-dept', '#people-conf'].forEach((s) => $(s).addEventListener('input', renderPeople));

/* ── Tools ────────────────────────────────────────────────── */

function renderTools() {
  const byVendor = new Map();
  for (const f of state.findings) {
    const v = byVendor.get(f.vendorId) || { id: f.vendorId, name: f.vendorName, category: f.category, rows: [] };
    v.rows.push(f);
    byVendor.set(f.vendorId, v);
  }
  const list = [...byVendor.values()].sort((a, b) => b.rows.length - a.rows.length || a.name.localeCompare(b.name));
  $('#tools-body').innerHTML = list.length
    ? list
        .map((v) => {
          const real = v.rows.filter((r) => !PSEUDO(r.userEmail));
          const who = real.slice(0, 6).map((r) => esc(r.name || r.userEmail)).join(', ') + (real.length > 6 ? ` +${real.length - 6}` : '');
          const org = v.rows.some((r) => r.userEmail === '(organisation-wide)') ? ' <span class="pill bad">Org-wide</span>' : '';
          return `<tr tabindex="0" data-tool="${esc(v.id)}"><td><strong>${esc(v.name)}</strong>${org}</td><td>${esc(v.category)}</td>
            <td class="num">${esc(real.length)}</td><td class="num">${esc(v.rows.filter((r) => r.paid).length)}</td><td class="small muted">${who || '—'}</td></tr>`;
        })
        .join('')
    : '<tr><td colspan="5" class="empty">No AI tools found yet.</td></tr>';
}

/* ── Evidence ─────────────────────────────────────────────── */

function renderEvidence() {
  const q = $('#ev-search').value.trim().toLowerCase();
  const conf = $('#ev-conf').value;
  const rows = state.findings.filter(
    (f) =>
      (!conf || f.confidence === conf) &&
      (!q || [f.userEmail, f.name, f.vendorName, f.department, ...f.evidence.map((e) => e.detail)].some((s) => s && s.toLowerCase().includes(q))),
  );
  $('#ev-body').innerHTML = rows.length
    ? rows
        .map(
          (f) => `<tr tabindex="0" data-person="${esc(f.userEmail)}">
          <td><div class="person-name">${esc(f.name || f.userEmail)}</div>${f.name ? `<div class="person-email">${esc(f.userEmail)}</div>` : ''}</td>
          <td>${esc(f.vendorName)}</td>
          <td><span class="conf"><span class="dot ${f.confidence}" style="display:inline-block;width:7px;height:7px;border-radius:50%"></span>${esc(cap(f.confidence))}</span></td>
          <td>${f.paid ? '<span class="pill warn">Paid</span>' : '<span class="muted">—</span>'}</td>
          <td class="small">${esc(fmtDate(f.firstSeen))}</td>
          <td class="small">${esc(fmtDate(f.lastSeen))}</td>
          <td class="small muted">${f.kinds.map((k) => esc(state.labels[k] || k)).join('<br>')}</td></tr>`,
        )
        .join('')
    : '<tr><td colspan="7" class="empty">No evidence matches.</td></tr>';
}
['#ev-search', '#ev-conf'].forEach((s) => $(s).addEventListener('input', renderEvidence));

/* ── Drawer ───────────────────────────────────────────────── */

function evidenceGroup(f, titleIsPerson) {
  const title = titleIsPerson ? f.name || f.userEmail : f.vendorName;
  return `<div class="ev-group"><h3><span>${esc(title)}</span><span class="row">${f.paid ? '<span class="pill warn">Paid</span>' : ''}<span class="pill neutral">${esc(cap(f.confidence))} confidence</span></span></h3>
    ${titleIsPerson ? `<p class="small muted" style="margin:2px 0 0">${esc(f.userEmail)}${f.department ? ` · ${esc(f.department)}` : ''}</p>` : `<p class="small muted" style="margin:2px 0 0">${esc(f.category)}</p>`}
    <ul class="ev-list">${f.evidence
      .map(
        (e) => `<li><div class="ev-kind">${esc(e.label)}</div>
        <div class="ev-meta">${esc(providerName(e.source))} · ${esc(fmtDate(e.observedAt))} · ${esc(cap(e.confidence))} confidence</div>
        <div class="ev-detail">${esc(e.detail)}</div></li>`,
      )
      .join('')}</ul></div>`;
}

let lastFocus = null;
function openDrawer({ eyebrow, title, sub, body }) {
  lastFocus = document.activeElement;
  $('#drawer-eyebrow').textContent = eyebrow;
  $('#drawer-title').textContent = title;
  $('#drawer-sub').textContent = sub;
  $('#drawer-body').innerHTML = body;
  $('#drawer').hidden = false;
  $('#drawer-backdrop').hidden = false;
  $('#drawer-close').focus();
}
function closeDrawer() {
  $('#drawer').hidden = true;
  $('#drawer-backdrop').hidden = true;
  lastFocus?.focus?.();
}
$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('#drawer').hidden && closeDrawer());

function openPerson(email) {
  const fs = state.findings.filter((f) => f.userEmail === email);
  if (!fs.length) return;
  const p = fs[0];
  openDrawer({
    eyebrow: 'Person',
    title: p.name || email,
    sub: [email, p.jobTitle, p.department].filter(Boolean).join(' · '),
    body: fs.map((f) => evidenceGroup(f, false)).join(''),
  });
}
function openTool(id) {
  const fs = state.findings.filter((f) => f.vendorId === id);
  if (!fs.length) return;
  openDrawer({
    eyebrow: fs[0].category,
    title: fs[0].vendorName,
    sub: `${fs.filter((f) => !PSEUDO(f.userEmail)).length} people`,
    body: fs.map((f) => evidenceGroup(f, true)).join(''),
  });
}

function rowActivate(e) {
  const tr = e.target.closest('tr[tabindex]');
  if (!tr || (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ')) return;
  e.preventDefault();
  if (tr.dataset.person) openPerson(tr.dataset.person);
  if (tr.dataset.tool) openTool(tr.dataset.tool);
}
['#people-body', '#tools-body', '#ev-body'].forEach((s) => {
  $(s).addEventListener('click', rowActivate);
  $(s).addEventListener('keydown', rowActivate);
});

/* ── Connections & scanning ───────────────────────────────── */

function renderConnections() {
  const st = state.status;
  if (!st) return;
  for (const name of ['google', 'microsoft']) {
    const c = st.connections[name];
    const card = $(`[data-connector="${name}"]`);
    const pill = $('[data-state]', card);
    pill.className = 'pill ' + (c.connected ? 'good' : c.error ? 'bad' : 'neutral');
    pill.textContent = c.connected ? (c.source === 'env' ? 'Connected via .env' : 'Connected') : c.error ? 'Error' : 'Not connected';
    const kv = !c.connected
      ? c.error
        ? [['Problem', c.error]]
        : []
      : name === 'google'
        ? [
            ['Service account', c.serviceAccountEmail],
            ['Super admin', c.adminEmail],
            ['Mailbox scan', c.scanMail ? 'On (sender and subject only)' : 'Off'],
          ]
        : [
            ['Tenant', c.tenantId],
            ['Client ID', c.clientId],
            ['Secret', c.secretHint],
            ['Mailbox scan', c.scanMail ? 'On (sender and subject only)' : 'Off'],
          ];
    $('[data-kv]', card).innerHTML = kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v || '—')}</dd>`).join('');
    $('[data-kv]', card).hidden = !kv.length;
    const label = name === 'google' ? 'Google Workspace' : 'Microsoft 365';
    $('[data-actions]', card).innerHTML = c.connected
      ? `<button class="btn btn-ghost btn-sm" data-act="test">Test connection</button>
         <button class="btn btn-ghost btn-sm" data-act="edit">Edit</button>
         ${c.source === 'ui' ? '<button class="btn btn-danger btn-sm" data-act="disconnect">Disconnect</button>' : ''}`
      : `<button class="btn btn-primary btn-sm" data-act="edit">Connect ${esc(label)}</button>`;
  }
  renderSettingsForms();
  const ls = st.lastScan;
  if (!ls) {
    $('#last-scan').innerHTML = '<p class="muted">No scans yet.</p>';
  } else {
    const stats = Object.entries(ls.stats || {})
      .map(([k, v]) => `<dt>${esc(statLabel(k))}</dt><dd>${esc(Number(v).toLocaleString('en-GB'))}</dd>`)
      .join('');
    $('#last-scan').innerHTML = `<dl class="kv"><dt>Status</dt><dd>${esc(SCAN_STATUS[ls.status] || cap(ls.status))}</dd><dt>Started</dt><dd>${esc(fmtDateTime(ls.startedAt))}</dd>
      <dt>Finished</dt><dd>${esc(fmtDateTime(ls.finishedAt))}</dd><dt>Sources</dt><dd>${esc(ls.providers.map(providerName).join(', '))}</dd>${stats}</dl>
      ${ls.warnings?.length ? `<strong class="small">${esc(ls.warnings.length)} ${ls.warnings.length === 1 ? 'warning' : 'warnings'}</strong><ul class="warnings small">${ls.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`;
  }
}

function renderScanStatus() {
  const st = state.status;
  const running = st?.scan.running;
  $('#scan-btn').disabled = !!running;
  $('#scan-btn').textContent = running ? 'Scanning…' : 'Run scan';
  $('#scan-status').textContent = running
    ? st.scan.progress
    : st?.lastScan?.finishedAt
      ? `Last scan ${fmtDateTime(st.lastScan.finishedAt)}`
      : '';
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const status = await api('/status');
      state.status = status;
      renderScanStatus();
      if (!status.scan.running) {
        clearInterval(pollTimer);
        pollTimer = null;
        await refresh();
      }
    } catch {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 2000);
}

$('#scan-btn').addEventListener('click', async () => {
  $('#scan-btn').disabled = true;
  try {
    await api('/scan', { method: 'POST', body: '{}' });
    await refresh();
    startPolling();
  } catch (err) {
    $('#scan-status').textContent = err.message;
    $('#scan-btn').disabled = false;
  }
});

/* ── Connector cards ──────────────────────────────────────── */

async function testConnector(name, out) {
  out.className = out.className.replace(/\b(good|bad)\b/g, '').trim();
  out.textContent = 'Testing connection…';
  try {
    const r = await api(`/test/${name}`, { method: 'POST' });
    out.textContent = r.message;
    out.classList.add('good');
    return true;
  } catch (err) {
    out.textContent = err.message;
    out.classList.add('bad');
    return false;
  }
}

$$('[data-connector]').forEach((card) =>
  card.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const name = card.dataset.connector;
    const out = $('[data-test-result]', card);
    if (btn.dataset.act === 'test') await testConnector(name, out);
    if (btn.dataset.act === 'edit') (name === 'google' ? openGoogleWizard : openMicrosoftWizard)();
    if (btn.dataset.act === 'disconnect') {
      const label = name === 'google' ? 'Google Workspace' : 'Microsoft 365';
      if (!confirm(`Disconnect ${label}? The saved credentials are deleted from this server. Existing results are kept.`)) return;
      await api(`/connections/${name}`, { method: 'DELETE' });
      out.textContent = '';
      await refresh();
    }
  }),
);

/* ── Connect wizards ──────────────────────────────────────── */

const copyBtn = (targetId) => `<button type="button" class="btn btn-ghost btn-sm" data-copy="${targetId}">Copy</button>`;
const ext = (href, text) => `<a class="ext" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)} ↗</a>`;

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const text = $('#' + b.dataset.copy)?.textContent ?? '';
  try {
    await navigator.clipboard.writeText(text);
    b.textContent = 'Copied';
  } catch {
    const range = document.createRange();
    range.selectNodeContents($('#' + b.dataset.copy));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    b.textContent = 'Press Ctrl+C';
  }
  setTimeout(() => (b.textContent = 'Copy'), 1800);
});

function wizardFooter(primary, extra = '') {
  return `<div class="wizard-footer"><button class="btn btn-primary" type="submit" form="wiz-form" id="wiz-save">${esc(primary)}</button>${extra}
    <button class="btn btn-ghost" type="button" id="wiz-cancel">Close</button><p class="small test-result" id="wiz-result" aria-live="polite"></p></div>`;
}

async function saveAndTest(name, payload) {
  const out = $('#wiz-result');
  const btn = $('#wiz-save');
  out.className = 'small test-result';
  out.textContent = 'Saving…';
  btn.disabled = true;
  try {
    await api(`/connections/${name}`, { method: 'PUT', body: JSON.stringify(payload) });
    const ok = await testConnector(name, out);
    if (!ok) out.textContent = `Saved, but the connection test failed: ${out.textContent}`;
    await refresh();
    return ok;
  } catch (err) {
    out.textContent = err.message;
    out.classList.add('bad');
    return false;
  } finally {
    btn.disabled = false;
  }
}

function openGoogleWizard() {
  const c = state.status.connections.google;
  const editing = c.connected;
  let keyJson = null;
  openDrawer({
    eyebrow: 'Connect',
    title: 'Google Workspace',
    sub: 'About 10 minutes. You need to be a Google Workspace super admin.',
    body: `<ol class="steps">
      <li><h3>Enable the Google APIs</h3>
        <p>In Google Cloud Console, create or pick a project, then enable both APIs:</p>
        <p>${ext('https://console.cloud.google.com/apis/library/admin.googleapis.com', 'Admin SDK API')} &nbsp; ${ext('https://console.cloud.google.com/apis/library/gmail.googleapis.com', 'Gmail API')}</p></li>
      <li><h3>Create a service account and upload its key</h3>
        <p>${ext('https://console.cloud.google.com/iam-admin/serviceaccounts/create', 'Create a service account')}. Name it <code>aisty-signal</code>; it needs no roles. Then open it → <strong>Keys → Add key → Create new key → JSON</strong>.</p>
        <div class="dropzone" id="g-drop" tabindex="0" role="button" aria-label="Upload service account JSON key">
          Drop the JSON key here or <strong>choose a file</strong>
          <input type="file" id="g-file" accept=".json,application/json" hidden>
        </div>
        <p class="key-summary" id="g-key-summary">${editing ? `Saved key: <strong>${esc(c.serviceAccountEmail)}</strong>. Upload a new file only to replace it.` : ''}</p></li>
      <li><h3>Allow domain-wide delegation</h3>
        <p>Open ${ext('https://admin.google.com/ac/owl/domainwidedelegation', 'Domain-wide delegation')} in the Admin console, click <strong>Add new</strong> and paste:</p>
        <label class="small">Client ID</label>
        <div class="copy"><code id="g-clientid">${esc(c.clientId || 'Upload the key file to see this')}</code>${copyBtn('g-clientid')}</div>
        <label class="small">OAuth scopes</label>
        <div class="copy"><code id="g-scopes"></code>${copyBtn('g-scopes')}</div>
        <p class="field-hint">Changes can take a few minutes to apply after you click Authorise.</p></li>
      <li><h3>Your details</h3>
        <form class="form" id="wiz-form" novalidate>
          <label for="g-admin">Super admin email</label>
          <input type="email" id="g-admin" placeholder="admin@yourcompany.com" value="${esc(c.adminEmail || '')}" required>
          <p class="field-hint">Aisty Signal acts as this admin to read the user directory and audit logs.</p>
          <label class="check"><input type="checkbox" id="g-mail" ${c.scanMail !== false ? 'checked' : ''}> Scan mailboxes for AI sign-up, login and receipt emails (sender and subject only)</label>
          <details><summary class="small muted">Advanced</summary>
            <label for="g-customer">Customer ID</label>
            <input type="text" id="g-customer" value="${esc(c.customerId || 'my_customer')}">
          </details>
        </form></li>
    </ol>${wizardFooter(editing ? 'Save and test' : 'Connect and test')}`,
  });

  const scopes = () => [...c.scopes.admin, ...($('#g-mail').checked ? c.scopes.mail : [])].join(',');
  const syncScopes = () => ($('#g-scopes').textContent = scopes());
  syncScopes();
  $('#g-mail').addEventListener('change', syncScopes);

  const readKey = async (file) => {
    const sum = $('#g-key-summary');
    if (!file) return;
    if (file.size > 20_000) {
      sum.innerHTML = '<span class="error">That file is too large to be a service account key.</span>';
      return;
    }
    const text = await file.text();
    try {
      const k = JSON.parse(text);
      if (k.type !== 'service_account' || !k.client_email || !k.private_key) throw new Error();
      keyJson = text;
      sum.innerHTML = `Key loaded: <strong>${esc(k.client_email)}</strong>${k.project_id ? ` (project ${esc(k.project_id)})` : ''}`;
      if (k.client_id) $('#g-clientid').textContent = k.client_id;
    } catch {
      keyJson = null;
      sum.innerHTML = '<span class="error">That is not a service account JSON key. Download it from the service account’s Keys tab.</span>';
    }
  };
  const drop = $('#g-drop');
  drop.addEventListener('click', () => $('#g-file').click());
  drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), $('#g-file').click()));
  drop.addEventListener('dragover', (e) => (e.preventDefault(), drop.classList.add('drag')));
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('drag');
    readKey(e.dataTransfer.files[0]);
  });
  $('#g-file').addEventListener('change', (e) => readKey(e.target.files[0]));

  $('#wiz-cancel').addEventListener('click', closeDrawer);
  $('#wiz-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!keyJson && !editing) {
      $('#wiz-result').textContent = 'Upload the service account JSON key first (step 2).';
      $('#wiz-result').className = 'small test-result bad';
      return;
    }
    await saveAndTest('google', {
      serviceAccountJson: keyJson || undefined,
      adminEmail: $('#g-admin').value,
      customerId: $('#g-customer').value,
      scanMail: $('#g-mail').checked,
    });
    keyJson = null;
  });
}

function openMicrosoftWizard() {
  const c = state.status.connections.microsoft;
  const editing = c.connected;
  const redirect = `${location.origin}/connect/microsoft/callback`;
  const needsLocalhost = location.protocol === 'http:' && location.hostname !== 'localhost';
  openDrawer({
    eyebrow: 'Connect',
    title: 'Microsoft 365',
    sub: 'About 5 minutes. You need to be a Global Administrator or Privileged Role Administrator.',
    body: `<ol class="steps">
      <li><h3>Register an app in Entra ID</h3>
        <p>${ext('https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade/quickStartType~/null/isMSAApp~/false', 'New app registration')}: name it <code>Aisty Signal</code> and choose <strong>Accounts in this organizational directory only</strong>. Under <strong>Redirect URI</strong>, pick <strong>Web</strong> and paste:</p>
        <div class="copy"><code id="m-redirect">${esc(redirect)}</code>${copyBtn('m-redirect')}</div>
        ${needsLocalhost ? `<p class="field-hint">Microsoft only accepts plain http for <code>localhost</code>. Open Aisty Signal at <code>http://localhost:${esc(location.port || '80')}</code> or serve it over HTTPS.</p>` : ''}</li>
      <li><h3>Add read-only permissions</h3>
        <p>In the app, go to <strong>API permissions → Add a permission → Microsoft Graph → Application permissions</strong> and add:</p>
        <table class="perm-table"><tbody>${c.permissions
          .map((p) => `<tr data-mail="${p.mail}"><td>${esc(p.name)}</td><td class="muted">${esc(p.why)}</td></tr>`)
          .join('')}</tbody></table>
        <p class="field-hint">You'll grant admin consent in step 5.</p></li>
      <li><h3>Create a client secret</h3>
        <p>Go to <strong>Certificates &amp; secrets → New client secret</strong>. Copy the secret <strong>Value</strong>, not the Secret ID. It's only shown once.</p></li>
      <li><h3>Paste the details</h3>
        <p>You'll find both IDs on the app's <strong>Overview</strong> page.</p>
        <form class="form" id="wiz-form" novalidate>
          <label for="m-tenant">Directory (tenant) ID</label>
          <input type="text" id="m-tenant" class="mono" placeholder="00000000-0000-0000-0000-000000000000" value="${esc(c.tenantId || '')}" required>
          <label for="m-client">Application (client) ID</label>
          <input type="text" id="m-client" class="mono" placeholder="00000000-0000-0000-0000-000000000000" value="${esc(c.clientId || '')}" required>
          <label for="m-secret">Client secret value</label>
          <input type="password" id="m-secret" autocomplete="off" placeholder="${editing ? `Saved (${esc(c.secretHint)}). Leave blank to keep it` : 'Paste the secret value'}">
          <label class="check"><input type="checkbox" id="m-mail" ${c.scanMail !== false ? 'checked' : ''}> Scan mailboxes for AI sign-up, login and receipt emails (sender and subject only)</label>
        </form></li>
      <li><h3>Grant admin consent</h3>
        <p>Save first, then approve the permissions for your organisation. Microsoft brings you back here afterwards.</p>
        <p><button type="button" class="btn btn-ghost btn-sm" id="m-consent" ${editing ? '' : 'disabled'}>Grant admin consent ↗</button></p>
        <p class="field-hint">Or click <strong>Grant admin consent</strong> on the app's API permissions page in Entra.</p></li>
    </ol>${wizardFooter(editing ? 'Save and test' : 'Save and test')}`,
  });

  const syncPerms = () => $$('.perm-table tr[data-mail="true"]').forEach((tr) => (tr.hidden = !$('#m-mail').checked));
  syncPerms();
  $('#m-mail').addEventListener('change', syncPerms);

  $('#m-consent').addEventListener('click', () => {
    const tenant = state.status.connections.microsoft.tenantId;
    const client = state.status.connections.microsoft.clientId;
    if (!tenant || !client) return;
    location.href = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/adminconsent?client_id=${encodeURIComponent(client)}&redirect_uri=${encodeURIComponent(redirect)}`;
  });

  $('#wiz-cancel').addEventListener('click', closeDrawer);
  $('#wiz-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await saveAndTest('microsoft', {
      tenantId: $('#m-tenant').value,
      clientId: $('#m-client').value,
      clientSecret: $('#m-secret').value,
      scanMail: $('#m-mail').checked,
    });
    $('#m-secret').value = '';
    $('#m-consent').disabled = !state.status.connections.microsoft.connected;
    if (!ok && state.status.connections.microsoft.connected) {
      $('#wiz-result').textContent += ' If you haven’t granted admin consent yet, do that in step 5, then test again.';
    }
  });
}

/* ── Settings forms ───────────────────────────────────────── */

function renderSettingsForms() {
  const st = state.status;
  const form = $('#scan-settings');
  if (!form.contains(document.activeElement)) {
    $('#set-lookback').value = st.settings.lookbackDays;
    $('#set-max').value = st.settings.maxMessagesPerUser;
    $('#set-subjects').checked = st.settings.storeSubjects;
  }
  const envPw = st.passwordSource === 'env';
  $('#pw-form').hidden = envPw || st.demo;
  $('#pw-env').hidden = !envPw || st.demo;
  $('#pw-demo').hidden = !st.demo;
}

$('#scan-settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('#scan-settings-result');
  try {
    await api('/settings/scan', {
      method: 'PUT',
      body: JSON.stringify({ lookbackDays: Number($('#set-lookback').value), maxMessagesPerUser: Number($('#set-max').value), storeSubjects: $('#set-subjects').checked }),
    });
    out.textContent = 'Saved. Applies to the next scan.';
  } catch (err) {
    out.textContent = err.message;
  }
});

$('#pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = $('#pw-result');
  try {
    await api('/password', { method: 'POST', body: JSON.stringify({ current: $('#pw-current').value, next: $('#pw-next').value }) });
    $('#pw-form').reset();
    out.textContent = 'Password changed. Other sessions are signed out.';
  } catch (err) {
    out.textContent = err.message;
  }
});

$('#csv-upload').addEventListener('click', async () => {
  const file = $('#csv-file').files[0];
  const out = $('#csv-result');
  if (!file) {
    out.textContent = 'Choose a CSV file first.';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    out.textContent = 'File is larger than 5 MB.';
    return;
  }
  out.textContent = 'Importing…';
  try {
    const { result } = await api('/import/csv', { method: 'POST', body: JSON.stringify({ csv: await file.text() }) });
    out.textContent = `Read ${result.rows} rows: ${result.matched} matched AI vendors (${result.unattributed} not matched to a person).`;
    await refresh();
  } catch (err) {
    out.textContent = err.message;
  }
});

$('#clear-data').addEventListener('click', async () => {
  if (!confirm('Delete all stored results from this server? This cannot be undone.')) return;
  await api('/data', { method: 'DELETE' });
  await refresh();
});

/* ── Tabs ─────────────────────────────────────────────────── */

function selectTab(name) {
  $$('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  $$('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
  history.replaceState(null, '', name === 'overview' ? location.pathname : `#${name}`);
  try {
    localStorage.setItem('signal-tab', name);
  } catch {}
}
$$('[role="tab"]').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
{
  let initial = location.hash.slice(1);
  if (!initial) {
    try {
      initial = localStorage.getItem('signal-tab') || '';
    } catch {}
  }
  if (/^[a-z]+$/.test(initial) && $(`[data-tab="${initial}"]`)) selectTab(initial);
}

/* ── Bar tooltips ─────────────────────────────────────────── */

const tip = $('#tooltip');
document.addEventListener('mousemove', (e) => {
  const row = e.target.closest?.('[data-tip]');
  if (!row) {
    tip.hidden = true;
    return;
  }
  tip.textContent = row.dataset.tip;
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY + 14}px`;
});

boot().catch((err) => console.error(err));
