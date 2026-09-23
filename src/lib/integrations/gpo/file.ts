/**
 * File-based roster adapter: the newest CSV/XLSX matching a pattern in a directory (the
 * INTEGRATION_FEED_DIR or a dedicated share), an SFTP drop, or an uploaded file, mapped
 * through the GPO's profile plus the company's overrides.
 */
import type { GpoRosterAdapter, ConnectionTestResult, Page, PullOptions } from "../core/contracts";
import type { GpoMembershipImportRecord } from "../types";
import { applyMapping, mergeMapping, type FieldMap } from "../core/mapping";
import { gridFromBuffer, locateFile, rowsFromGrid, type FileSource } from "../core/tabular";
import { MEMBERSHIP_SPEC, type GpoProfile } from "./profiles";

export type RosterFileConfig = { profile: GpoProfile; source: FileSource; sheet?: string | null; headerRow?: number; mapping?: FieldMap | null };

export class FileRosterAdapter implements GpoRosterAdapter {
  readonly provider = "file";
  readonly gpoName: string;
  constructor(private cfg: RosterFileConfig) { this.gpoName = cfg.profile.gpoName; }

  async testConnection(): Promise<ConnectionTestResult> {
    const f = await locateFile(this.cfg.source);
    if (!f) return { ok: false, message: `No roster file found (${describe(this.cfg.source)})` };
    const grid = await gridFromBuffer(f.buffer, f.name, this.cfg.sheet);
    const { headers, rows } = rowsFromGrid(grid, this.cfg.headerRow ?? 1);
    const map = mergeMapping(this.cfg.profile.fileMapping, this.cfg.mapping);
    const missing = Object.entries(map).filter(([, r]) => r.source && !headers.some((h) => h.toLowerCase() === r.source!.toLowerCase())).map(([k, r]) => `${k} ← "${r.source}"`);
    const required = MEMBERSHIP_SPEC.fields.filter((x) => x.required).map((x) => x.name).filter((n) => { const r = map[n]; return !r || (r.source && !headers.some((h) => h.toLowerCase() === r.source!.toLowerCase())); });
    if (required.length) return { ok: false, message: `${f.name}: required columns not found for ${required.join(", ")}; file headers are: ${headers.slice(0, 12).join(" | ")}${headers.length > 12 ? " …" : ""}`, details: { file: f.name, rows: rows.length, headers } };
    return { ok: true, message: `${f.name}: ${rows.length} rows, ${headers.length} columns${missing.length ? `; unmapped optional fields: ${missing.join(", ")}` : ""}`, details: { file: f.name, rows: rows.length, headers, modifiedAt: f.modifiedAt?.toISOString() ?? null } };
  }

  async fetchMemberships(opts?: PullOptions): Promise<Page<GpoMembershipImportRecord>> {
    const f = await locateFile(this.cfg.source);
    if (!f) return { records: [], nextCursor: null };
    if (opts?.cursor && opts.cursor === `file:${f.hash}`) return { records: [], nextCursor: null }; // same file already consumed
    const grid = await gridFromBuffer(f.buffer, f.name, this.cfg.sheet);
    const { rows } = rowsFromGrid(grid, this.cfg.headerRow ?? 1);
    const map = mergeMapping(this.cfg.profile.fileMapping, this.cfg.mapping);
    const records: GpoMembershipImportRecord[] = [];
    const rejected: { externalId: string | null; message: string }[] = [];
    for (const row of rows) {
      const m = applyMapping<Record<string, unknown>>(row, map, MEMBERSHIP_SPEC);
      const errors = m.issues.filter((i) => i.level === "error");
      const r = m.record;
      const rowNo = Number(row.__row);
      // a bad row is reported, never silently dropped — and never stops the rest of the file
      if (errors.length) { rejected.push({ externalId: (r.externalMembershipId as string) ?? `${f.name}#${rowNo}`, message: `${f.name} row ${rowNo}: ${errors.map((e) => e.message).join("; ")}` }); continue; }
      records.push({
        gpoName: this.cfg.profile.gpoName, gpoCode: this.cfg.profile.gpoCode,
        accountExternalId: (r.accountExternalId as string) ?? null, accountNumber: (r.accountNumber as string) ?? null,
        externalMembershipId: (r.externalMembershipId as string) ?? null, memberName: (r.memberName as string) ?? null,
        address: r.addressLine1 || r.city || r.region || r.postalCode ? { line1: (r.addressLine1 as string) ?? null, city: (r.city as string) ?? null, region: (r.region as string) ?? null, postalCode: (r.postalCode as string) ?? null, country: (r.country as string) ?? null } : null,
        tier: (r.tier as string) ?? null, effectiveFrom: String(r.effectiveFrom), effectiveTo: (r.effectiveTo as string) ?? null, lastVerifiedAt: (r.lastVerifiedAt as string) ?? null, source: "gpo-feed",
        provenance: { provider: "file", sourceSystem: this.cfg.profile.key, sourceRecordId: (r.externalMembershipId as string) ?? `${f.name}#${rowNo}`, sourceUpdatedAt: f.modifiedAt?.toISOString() ?? null, meta: { file: f.name, row: rowNo, parentMemberName: (r.parentMemberName as string) ?? null } },
      });
    }
    return { records, nextCursor: null, rejected };
  }
}

function describe(s: FileSource): string { return s.kind === "directory" ? `${s.pattern} in ${s.directory}` : s.kind === "sftp" ? `${s.pattern} on sftp://${s.host}${s.directory}` : s.filename; }
