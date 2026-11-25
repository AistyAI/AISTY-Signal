import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export interface Vendor {
  id: string;
  name: string;
  category: string;
  website: string;
  emailDomains: string[];
  appNames: string[];
  billingNames?: string[];
}

interface CatalogueFile {
  paymentProcessorDomains: string[];
  vendors: Vendor[];
}

const file = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'catalogue', 'ai-vendors.json'), 'utf8'),
) as CatalogueFile;

export const vendors: Vendor[] = file.vendors;
export const paymentProcessorDomains: string[] = file.paymentProcessorDomains.map((d) => d.toLowerCase());

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-word, case-insensitive phrase matcher. "Claude" matches "Claude for Work", not "Claudette". */
const phrase = (s: string) => new RegExp(`(^|[^a-z0-9])${escape(s)}($|[^a-z0-9])`, 'i');

const appMatchers = vendors.map((v) => ({ v, res: v.appNames.map(phrase) }));
const billingMatchers = vendors.map((v) => ({
  v,
  res: [...new Set([...(v.billingNames ?? []), ...v.appNames])].map(phrase),
}));

/** True when `domain` equals `root` or is a subdomain of it (tm.openai.com → openai.com). */
export function domainMatches(domain: string, root: string): boolean {
  const d = domain.toLowerCase();
  const r = root.toLowerCase();
  return d === r || d.endsWith('.' + r);
}

export function vendorForSenderDomain(domain: string): Vendor | undefined {
  return vendors.find((v) => v.emailDomains.some((root) => domainMatches(domain, root)));
}

export function isPaymentProcessor(domain: string): boolean {
  return paymentProcessorDomains.some((root) => domainMatches(domain, root));
}

export function vendorForAppName(...names: (string | undefined)[]): Vendor | undefined {
  const text = names.filter(Boolean).join(' | ');
  if (!text) return undefined;
  return appMatchers.find(({ res }) => res.some((re) => re.test(text)))?.v;
}

export function vendorForBillingText(text: string): Vendor | undefined {
  if (!text) return undefined;
  return billingMatchers.find(({ res }) => res.some((re) => re.test(text)))?.v;
}

/**
 * Apps that aren't in the catalogue but whose name strongly suggests AI.
 * Reported as low-confidence "unlisted" findings so nothing slips through silently.
 */
const AI_WORD = /(^|[^a-z0-9])(ai|llm|copilot|chatbot|genai|gen ai|machine learning|transcri\w*|notetaker)($|[^a-z0-9])/i;
const AI_FRAGMENT = /gpt|llm/i; // "SalesGPT", "MyLLMTool"
export function looksLikeAi(name: string | undefined): boolean {
  return Boolean(name && (AI_WORD.test(name) || AI_FRAGMENT.test(name)));
}

export function unlistedVendorId(name: string): string {
  return 'unlisted:' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/** All sender domains worth searching mailboxes for. */
export function searchDomains(): string[] {
  return [...new Set([...vendors.flatMap((v) => v.emailDomains), ...paymentProcessorDomains])].map((d) =>
    d.toLowerCase(),
  );
}

/** Split domains into chunks so each mailbox search query stays well under provider limits. */
export function chunkDomains(domains: string[], maxChars = 900): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const d of domains) {
    if (cur.length && len + d.length + 9 > maxChars) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(d);
    len += d.length + 9;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
