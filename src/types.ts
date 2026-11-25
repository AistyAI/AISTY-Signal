export type Provider = 'google' | 'microsoft' | 'csv' | 'demo';
export type Confidence = 'high' | 'medium' | 'low';

export type EvidenceKind =
  | 'oauth_grant' // user granted "Sign in with Google/Microsoft" access to the tool
  | 'oauth_authorize_event' // audit-log record of a user authorising the tool
  | 'app_assignment' // user assigned to the tool's enterprise app (Entra ID)
  | 'admin_consent' // an admin consented to the tool for the whole organisation
  | 'email_signup' // welcome / verify / invite email from the vendor
  | 'email_login' // login code / password reset / security email from the vendor
  | 'email_receipt' // receipt, invoice or subscription email (paid)
  | 'email_other' // any other email from the vendor's sending domain
  | 'csv_transaction'; // matching line on an imported card/expense statement

export const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  oauth_grant: 'Signed in with company account',
  oauth_authorize_event: 'Sign-in authorisation (audit log)',
  app_assignment: 'Assigned to enterprise app',
  admin_consent: 'Admin consent for whole organisation',
  email_signup: 'Sign-up / welcome email',
  email_login: 'Login or security email',
  email_receipt: 'Receipt or subscription email',
  email_other: 'Other email from vendor',
  csv_transaction: 'Card / expense transaction',
};

export interface Person {
  email: string; // lower-case primary address, or a pseudo id such as "(organisation-wide)"
  name?: string;
  department?: string;
  jobTitle?: string;
  sources: Provider[];
}

export interface Evidence {
  id: string; // stable hash, used to de-duplicate across scans
  userEmail: string;
  vendorId: string;
  vendorName: string;
  category: string;
  kind: EvidenceKind;
  confidence: Confidence;
  paid: boolean;
  source: Provider;
  observedAt?: string; // ISO date
  detail: string; // e.g. sender + subject, or app name
}

export interface ScanRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  providers: Provider[];
  status: 'running' | 'done' | 'failed';
  warnings: string[];
  stats: Record<string, number>;
}

export interface StoreData {
  version: 1;
  people: Record<string, Person>;
  evidence: Evidence[];
  scans: ScanRun[];
}

export const ORG_WIDE = '(organisation-wide)';
export const UNATTRIBUTED = '(unattributed)';

/** Everything a provider needs to report results back to the scan orchestrator. */
export interface ScanContext {
  lookbackDays: number;
  maxMessagesPerUser: number;
  concurrency: number;
  storeSubjects: boolean;
  addPerson(p: Omit<Person, 'sources'>, source: Provider): void;
  addEvidence(e: Omit<Evidence, 'id'>): void;
  warn(message: string): void;
  progress(message: string): void;
  bump(stat: string, by?: number): void;
}
