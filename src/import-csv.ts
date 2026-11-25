/**
 * Import a card / expense statement CSV to catch paid AI subscriptions that
 * email scanning might miss. Columns are detected by header name.
 */
import { vendorForBillingText } from './catalogue.js';
import { getStore, replaceEvidence, saveStore, upsertPerson } from './store.js';
import { hashId, parseCsv, truncate } from './util.js';
import { UNATTRIBUTED, type Evidence } from './types.js';

const COLS = {
  email: /^(e-?mail|employee e-?mail|user e-?mail|cardholder e-?mail|work e-?mail)$/i,
  person: /^(name|employee|employee name|cardholder|card ?holder name|user|spender|submitted by)$/i,
  description: /^(description|merchant|merchant name|payee|vendor|supplier|narrative|details|memo|transaction description)$/i,
  date: /^(date|transaction date|posted date|posting date|expense date|txn date)$/i,
  amount: /^(amount|value|total|debit|net amount|gross amount)$/i,
};

export interface ImportResult {
  rows: number;
  matched: number;
  unattributed: number;
  columns: Record<string, string | null>;
}

export function importCsv(text: string, opts: { replace?: boolean } = { replace: true }): ImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('The CSV needs a header row and at least one data row.');
  const header = rows[0].map((h) => h.trim());
  const find = (re: RegExp) => header.findIndex((h) => re.test(h));
  const idx = {
    email: find(COLS.email),
    person: find(COLS.person),
    description: find(COLS.description),
    date: find(COLS.date),
    amount: find(COLS.amount),
  };
  if (idx.description < 0) {
    throw new Error(`Could not find a description/merchant column. Headers seen: ${header.join(', ')}`);
  }

  const store = getStore();
  const byName = new Map(
    Object.values(store.people)
      .filter((p) => p.name)
      .map((p) => [p.name!.toLowerCase(), p.email]),
  );

  const evidence: Evidence[] = [];
  let unattributed = 0;
  for (const r of rows.slice(1)) {
    const desc = r[idx.description] ?? '';
    const vendor = vendorForBillingText(desc);
    if (!vendor) continue;
    const rawEmail = idx.email >= 0 ? r[idx.email]?.trim().toLowerCase() : '';
    const rawName = idx.person >= 0 ? r[idx.person]?.trim() : '';
    let userEmail = rawEmail && rawEmail.includes('@') ? rawEmail : rawName ? byName.get(rawName.toLowerCase()) : undefined;
    if (!userEmail) {
      userEmail = UNATTRIBUTED;
      unattributed++;
    } else if (!store.people[userEmail]) {
      upsertPerson({ email: userEmail, name: rawName || undefined }, 'csv');
    }
    const dateRaw = idx.date >= 0 ? r[idx.date] : '';
    const parsed = dateRaw ? new Date(dateRaw) : null;
    const observedAt = parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined;
    const amount = idx.amount >= 0 ? r[idx.amount]?.trim() : '';
    const detail = truncate(`${desc}${amount ? ` · ${amount}` : ''}${rawName && userEmail === UNATTRIBUTED ? ` · ${rawName}` : ''}`, 200);
    evidence.push({
      id: hashId('csv', userEmail, vendor.id, detail, observedAt),
      userEmail,
      vendorId: vendor.id,
      vendorName: vendor.name,
      category: vendor.category,
      kind: 'csv_transaction',
      confidence: 'high',
      paid: true,
      source: 'csv',
      observedAt,
      detail,
    });
  }

  if (opts.replace !== false) replaceEvidence(['csv'], evidence);
  else replaceEvidence([], evidence);
  saveStore();
  return {
    rows: rows.length - 1,
    matched: evidence.length,
    unattributed,
    columns: Object.fromEntries(Object.entries(idx).map(([k, i]) => [k, i >= 0 ? header[i] : null])),
  };
}
