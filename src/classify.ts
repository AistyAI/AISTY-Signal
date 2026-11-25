import { isPaymentProcessor, vendorForBillingText, vendorForSenderDomain, type Vendor } from './catalogue.js';
import type { Confidence, EvidenceKind } from './types.js';

export interface ParsedSender {
  name: string;
  address: string;
  domain: string;
}

/** Parse an RFC 5322 From value such as `"OpenAI" <noreply@tm.openai.com>`. */
export function parseFrom(from: string | undefined): ParsedSender | null {
  if (!from) return null;
  const angle = from.match(/<([^<>\s]+@[^<>\s]+)>/);
  const bare = from.match(/([^\s<>"]+@[^\s<>"]+)/);
  const address = (angle?.[1] ?? bare?.[1] ?? '').toLowerCase().replace(/[>;,]+$/, '');
  const at = address.lastIndexOf('@');
  if (at < 1) return null;
  const name = angle ? from.slice(0, from.indexOf('<')).replace(/["']/g, '').trim() : '';
  return { name, address, domain: address.slice(at + 1) };
}

// Deliberately strict: marketing mail ("New for Plus users!") must not count as a paid subscription.
const RECEIPT =
  /\b(receipt|invoice|payment (received|confirm\w*|successful|failed)|you('|’)ve been charged|billing (statement|update)|subscription (confirm\w*|renew\w*|start\w*|activated|receipt)|renewal (notice|reminder)|order confirmation)\b/i;
const SIGNUP =
  /\b(welcome|verify your|confirm your|activate|get(ting)? started|you('|’)re in|account (created|confirmation|ready)|sign(ed)? up|invit\w*|joined|onboard\w*)\b/i;
const LOGIN =
  /\b(log[- ]?in|sign[- ]?in|magic link|one[- ]time|verification code|security (code|alert)|password|new device|2fa|two[- ]factor)\b/i;

export interface EmailClassification {
  vendor: Vendor;
  kind: EvidenceKind;
  confidence: Confidence;
  paid: boolean;
}

/**
 * Decide whether a message (from metadata only: sender + subject) is evidence
 * that the recipient has an account with an AI vendor, and how strong it is.
 */
export function classifyEmail(from: string | undefined, subject: string | undefined): EmailClassification | null {
  const sender = parseFrom(from);
  if (!sender) return null;
  const subj = subject ?? '';

  // Direct vendor mail.
  const vendor = vendorForSenderDomain(sender.domain);
  if (vendor) {
    if (RECEIPT.test(subj)) return { vendor, kind: 'email_receipt', confidence: 'high', paid: true };
    if (SIGNUP.test(subj)) return { vendor, kind: 'email_signup', confidence: 'high', paid: false };
    if (LOGIN.test(subj)) return { vendor, kind: 'email_login', confidence: 'high', paid: false };
    return { vendor, kind: 'email_other', confidence: 'low', paid: false };
  }

  // Receipts sent by a payment processor on the vendor's behalf ("Your receipt from Anthropic").
  if (isPaymentProcessor(sender.domain)) {
    const billed = vendorForBillingText(`${sender.name} ${subj}`);
    if (billed) return { vendor: billed, kind: 'email_receipt', confidence: 'high', paid: true };
  }
  return null;
}
