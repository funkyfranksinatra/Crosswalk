/**
 * Competitor size coverage — the worklist behind "populate the competitor size master".
 *
 * GUDID carries no dimensions for most Ethicon meshes and stapler reloads, so those lines
 * tie to our smallest product. Product marketing can fix that with the size import, but
 * nobody can size thousands of codes: this module ranks every competitor code Crosswalk has
 * seen by what it is worth (units × the best known competitor price, across every account
 * list and price observation), says which ones are already sized and from where, and
 * emits the fill-in template in that order — the top of the sheet is where the money is.
 */
import { prisma } from "@/lib/db";
import { compactCfn, normalizeCfn } from "@/lib/cfn";
import { parseBin } from "@/lib/match/bin";
import { SIZE_NAMES } from "@/lib/excel/sizes";

export type CoverageRow = {
  code: string;
  manufacturer: string | null;
  description: string | null;
  family: string | null;
  lines: number;
  accounts: number;
  units: number;
  /** Best available unit price: median of price observations, else the rep's estimate. */
  unitPrice: number | null;
  spend: number;
  sized: "import" | "gudid" | "description" | null;
  dims: string | null;
  priority: number;
};

export async function sizeCoverage(opts: { limit?: number } = {}): Promise<{ rows: CoverageRow[]; totals: { codes: number; sized: number; unsized: number; unsizedSpend: number; coveredSpendPct: number } }> {
  const [cps, specs, lines, obs] = await Promise.all([
    prisma.competitorProduct.findMany({ where: { resolution: { not: "not-found" } }, select: { cfnNorm: true, cfnMatched: true, manufacturer: true, description: true, category: true, binJson: true, gudidJson: true } }),
    prisma.competitorSpec.findMany({ select: { cfnNorm: true, dimsJson: true } }),
    prisma.requestLine.findMany({ where: { resolutionStatus: "resolved" }, select: { cfnNorm: true, quantity: true, estCompetitorPrice: true, request: { select: { accountNumber: true, accountId: true } } } }),
    prisma.competitorPriceObservation.findMany({ select: { competitorSku: true, price: true } }),
  ]);
  const onFile = new Map(specs.map((s) => [s.cfnNorm, s.dimsJson]));
  const priceByCode = new Map<string, number[]>();
  for (const o of obs) { const k = compactCfn(normalizeCfn(o.competitorSku)); const v = Number(o.price); if (Number.isFinite(v) && v > 0) priceByCode.set(k, [...(priceByCode.get(k) ?? []), v]); }
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

  const usage = new Map<string, { lines: number; accounts: Set<string>; units: number; est: number[] }>();
  for (const l of lines) {
    const k = compactCfn(normalizeCfn(l.cfnNorm));
    const u = usage.get(k) ?? { lines: 0, accounts: new Set<string>(), units: 0, est: [] };
    u.lines++; u.units += Number(l.quantity) || 0;
    u.accounts.add(l.request.accountNumber ?? l.request.accountId ?? "?");
    const p = l.estCompetitorPrice === null ? null : Number(l.estCompetitorPrice);
    if (p !== null && Number.isFinite(p) && p > 0) u.est.push(p);
    usage.set(k, u);
  }

  const rows: CoverageRow[] = [];
  for (const cp of cps) {
    const k = compactCfn(cp.cfnNorm);
    const spec = onFile.get(k) ?? (cp.cfnMatched ? onFile.get(compactCfn(cp.cfnMatched.toUpperCase())) : undefined);
    const bin = parseBin(cp.binJson, { allowStale: true });
    const binDims = bin?.dimensions.filter((d) => SIZE_NAMES.has(d.name)) ?? [];
    let sized: CoverageRow["sized"] = null;
    let dims: string | null = null;
    if (spec) { sized = "import"; try { dims = (JSON.parse(spec) as { name: string; value: number; unit: string }[]).map((d) => `${d.name} ${d.value} ${d.unit}`).join(", "); } catch { dims = null; } }
    else if (binDims.length) {
      let fromGudid = false;
      try { fromGudid = Boolean(cp.gudidJson && ((JSON.parse(cp.gudidJson) as { device_sizes?: unknown[] }).device_sizes?.length ?? 0) > 0); } catch { fromGudid = false; }
      sized = fromGudid ? "gudid" : "description";
      dims = binDims.map((d) => `${d.name} ${d.value} ${d.unit}`).join(", ");
    }
    const u = usage.get(k);
    const unitPrice = median(priceByCode.get(k) ?? []) ?? median(u?.est ?? []);
    const units = u?.units ?? 0;
    rows.push({ code: cp.cfnNorm, manufacturer: cp.manufacturer, description: cp.description, family: bin?.family ?? cp.category ?? null, lines: u?.lines ?? 0, accounts: u?.accounts.size ?? 0, units, unitPrice, spend: unitPrice !== null ? Math.round(units * unitPrice) : 0, sized, dims, priority: 0 });
  }
  // Unsized first; within a group by spend, then units, then how many lists it appeared on.
  rows.sort((a, b) => Number(Boolean(a.sized)) - Number(Boolean(b.sized)) || b.spend - a.spend || b.units - a.units || b.lines - a.lines || a.code.localeCompare(b.code));
  rows.forEach((r, i) => { r.priority = i + 1; });
  const unsized = rows.filter((r) => !r.sized);
  const totalSpend = rows.reduce((a, r) => a + r.spend, 0);
  const unsizedSpend = unsized.reduce((a, r) => a + r.spend, 0);
  const out = opts.limit ? rows.slice(0, opts.limit) : rows;
  return { rows: out, totals: { codes: rows.length, sized: rows.length - unsized.length, unsized: unsized.length, unsizedSpend, coveredSpendPct: totalSpend ? Math.round(((totalSpend - unsizedSpend) / totalSpend) * 100) : 100 } };
}
