import type { Confidence, Evidence, EvidenceKind, Person, Provider, StoreData } from './types.js';
import { EVIDENCE_LABELS, ORG_WIDE, UNATTRIBUTED } from './types.js';

export interface Finding {
  userEmail: string;
  name?: string;
  department?: string;
  jobTitle?: string;
  vendorId: string;
  vendorName: string;
  category: string;
  confidence: Confidence;
  paid: boolean;
  firstSeen?: string;
  lastSeen?: string;
  kinds: EvidenceKind[];
  sources: Provider[];
  evidence: (Evidence & { label: string })[];
}

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export function isPseudoUser(email: string): boolean {
  return email === ORG_WIDE || email === UNATTRIBUTED || email.startsWith('group:');
}

export function buildFindings(data: StoreData): Finding[] {
  const map = new Map<string, Finding>();
  for (const e of data.evidence) {
    const key = `${e.userEmail}\u0000${e.vendorId}`;
    let f = map.get(key);
    if (!f) {
      const p: Person | undefined = data.people[e.userEmail];
      f = {
        userEmail: e.userEmail,
        name: p?.name,
        department: p?.department,
        jobTitle: p?.jobTitle,
        vendorId: e.vendorId,
        vendorName: e.vendorName,
        category: e.category,
        confidence: e.confidence,
        paid: false,
        kinds: [],
        sources: [],
        evidence: [],
      };
      map.set(key, f);
    }
    if (RANK[e.confidence] > RANK[f.confidence]) f.confidence = e.confidence;
    f.paid ||= e.paid;
    if (!f.kinds.includes(e.kind)) f.kinds.push(e.kind);
    if (!f.sources.includes(e.source)) f.sources.push(e.source);
    if (e.observedAt) {
      if (!f.firstSeen || e.observedAt < f.firstSeen) f.firstSeen = e.observedAt;
      if (!f.lastSeen || e.observedAt > f.lastSeen) f.lastSeen = e.observedAt;
    }
    f.evidence.push({ ...e, label: EVIDENCE_LABELS[e.kind] });
  }
  for (const f of map.values()) f.evidence.sort((a, b) => (b.observedAt ?? '').localeCompare(a.observedAt ?? ''));
  return [...map.values()].sort(
    (a, b) => RANK[b.confidence] - RANK[a.confidence] || a.vendorName.localeCompare(b.vendorName) || a.userEmail.localeCompare(b.userEmail),
  );
}

export function summarise(data: StoreData, findings: Finding[]) {
  const real = findings.filter((f) => !isPseudoUser(f.userEmail));
  const people = new Set(real.map((f) => f.userEmail));
  const byVendor = new Map<string, { vendorId: string; vendorName: string; category: string; users: Set<string>; paid: number }>();
  for (const f of findings) {
    const v = byVendor.get(f.vendorId) ?? { vendorId: f.vendorId, vendorName: f.vendorName, category: f.category, users: new Set(), paid: 0 };
    if (!isPseudoUser(f.userEmail)) v.users.add(f.userEmail);
    if (f.paid) v.paid++;
    byVendor.set(f.vendorId, v);
  }
  const byDept = new Map<string, Set<string>>();
  for (const f of real) {
    const d = f.department || 'Unknown';
    byDept.set(d, (byDept.get(d) ?? new Set()).add(f.userEmail));
  }
  const directorySize = Object.values(data.people).filter((p) => !isPseudoUser(p.email) && p.sources.some((s) => s !== 'csv')).length;
  return {
    peopleWithAi: people.size,
    directorySize,
    tools: byVendor.size,
    paidSubscriptions: findings.filter((f) => f.paid).length,
    orgWideConsents: findings.filter((f) => f.userEmail === ORG_WIDE).length,
    byVendor: [...byVendor.values()]
      .map((v) => ({ vendorId: v.vendorId, vendorName: v.vendorName, category: v.category, users: v.users.size, paid: v.paid }))
      .sort((a, b) => b.users - a.users || a.vendorName.localeCompare(b.vendorName)),
    byDepartment: [...byDept.entries()]
      .map(([department, s]) => ({ department, users: s.size }))
      .sort((a, b) => b.users - a.users),
  };
}
