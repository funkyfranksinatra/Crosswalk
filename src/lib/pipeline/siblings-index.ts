/**
 * The sibling-family index a run (and the eval harness) hands to binning: the labeler's other
 * records in the same product line, from the GUDID library, grouped by manufacturer + brand root
 * once per run (docs/MATCH_QUALITY_MODEL.md §3.4). A labeler that is not in the library contributes
 * nothing — Catalog → GUDID library imports it.
 */
import { prisma } from "@/lib/db";
import { brandRoot, type SiblingRecord } from "@/lib/match/siblings";

export type SiblingIndex = { get(manufacturer: string | null | undefined, brand: string | null | undefined): SiblingRecord[] | null; lines: number };

export async function loadSiblingIndex(manufacturers: Iterable<string | null | undefined>, perLabelerCap = 25_000): Promise<SiblingIndex> {
  const byLine = new Map<string, SiblingRecord[]>();
  for (const mfr of new Set([...manufacturers].filter((m): m is string => Boolean(m)))) {
    const rows = await prisma.gudidDevice.findMany({ where: { manufacturer: mfr, brand: { not: null } }, select: { cfnNorm: true, brand: true, description: true }, take: perLabelerCap });
    for (const r of rows) {
      const key = `${mfr}\u0000${brandRoot(r.brand)}`;
      const list = byLine.get(key) ?? [];
      list.push({ code: r.cfnNorm, brand: r.brand, description: r.description });
      byLine.set(key, list);
    }
  }
  return {
    get: (manufacturer, brand) => (manufacturer && brand ? byLine.get(`${manufacturer}\u0000${brandRoot(brand)}`) ?? null : null),
    lines: byLine.size,
  };
}
