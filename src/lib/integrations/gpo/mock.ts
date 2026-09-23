/** MockGpoRosterAdapter — a stand-in roster feed for any of the three GPOs. Labelled MOCK. */
import type { GpoRosterAdapter, ConnectionTestResult, Page, PullOptions } from "../core/contracts";
import type { GpoMembershipImportRecord } from "../types";
import { scenarioGate, malformed, type MockScenario } from "../core/mock";
import type { GpoProfile } from "./profiles";

export function mockRoster(profile: GpoProfile): GpoMembershipImportRecord[] {
  const prov = (id: string) => ({ provider: "mock", sourceSystem: `${profile.key}-mock`, sourceRecordId: id, meta: { file: "mock-roster.csv" } });
  return [
    { gpoName: profile.gpoName, gpoCode: profile.gpoCode, accountNumber: "MOCK-0002", accountExternalId: null, externalMembershipId: `${profile.gpoCode}-M-1001`, memberName: "Lakeshore Regional Hospital", address: { line1: "1 Harbor Way", city: "Buffalo", region: "NY", postalCode: "14202", country: "US" }, tier: "Tier 2", effectiveFrom: "2026-01-01", effectiveTo: null, lastVerifiedAt: "2026-08-30", source: "gpo-feed", provenance: prov(`${profile.gpoCode}-M-1001`) },
    { gpoName: profile.gpoName, gpoCode: profile.gpoCode, accountNumber: null, accountExternalId: null, externalMembershipId: `${profile.gpoCode}-M-1002`, memberName: "Pine Ridge Community Hospital", address: { line1: "44 Ridge Rd", city: "Missoula", region: "MT", postalCode: "59801", country: "US" }, tier: "Tier 1", effectiveFrom: "2026-03-01", effectiveTo: null, lastVerifiedAt: "2026-08-30", source: "gpo-feed", provenance: prov(`${profile.gpoCode}-M-1002`) },
    { gpoName: profile.gpoName, gpoCode: profile.gpoCode, accountNumber: "0001880967", accountExternalId: null, externalMembershipId: `${profile.gpoCode}-M-1003`, memberName: "Memorial Sloan Kettering", address: null, tier: "Tier 3", effectiveFrom: "2025-07-01", effectiveTo: "2026-06-30", lastVerifiedAt: "2026-06-01", source: "gpo-feed", provenance: prov(`${profile.gpoCode}-M-1003`) },
  ];
}

export class MockGpoRosterAdapter implements GpoRosterAdapter {
  readonly provider = "mock";
  readonly gpoName: string;
  constructor(private profile: GpoProfile, private scenario: MockScenario = "ok") { this.gpoName = profile.gpoName; }
  async testConnection(): Promise<ConnectionTestResult> { scenarioGate(this.scenario, this.profile.gpoName); return { ok: true, message: `MOCK ${this.profile.gpoName} roster: 3 members (no real feed)`, details: { scenario: this.scenario } }; }
  async fetchMemberships(opts?: PullOptions): Promise<Page<GpoMembershipImportRecord>> {
    scenarioGate(this.scenario, this.profile.gpoName);
    if (this.scenario === "malformed") malformed(this.profile.gpoName);
    if (this.scenario === "empty") return { records: [], nextCursor: null };
    let records = mockRoster(this.profile);
    if (this.scenario === "duplicate") records = [...records, { ...records[0] }];
    if (this.scenario === "partial") records = records.map((r, i) => (i === 1 ? { ...r, effectiveFrom: "not-a-date" } : r));
    const size = opts?.limit ?? 50; const start = opts?.cursor ? Number(opts.cursor.replace("mock:", "")) : 0;
    return { records: records.slice(start, start + size), nextCursor: start + size < records.length ? `mock:${start + size}` : null };
  }
}
