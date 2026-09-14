/**
 * Competitor sizes import.
 *
 * FDA GUDID sizes many devices only partially or not at all (Ethicon meshes
 * carry no dimensions; many reloads list only a length). A rep usually knows
 * the size from the competitor's catalog. This import stores those sizes per
 * competitor code (`CompetitorSpec`) and they are applied to the competitor
 * bin ahead of GUDID and regex sizes. The template is pre-filled with every
 * competitor code Crosswalk has seen that still lacks a width/length/diameter, so
 * the rep only fills in what is missing.
 */
import ExcelJS from "exceljs";
import { prisma } from "@/lib/db";
import { compactCfn, normalizeCfn } from "@/lib/cfn";
import { extractDimensions, parseBin, type Dimension } from "@/lib/match/bin";

export type SizesImportResult = { upserted: number; rows: number; skipped: string[]; rebinned: number };

const SIZE_NAMES = new Set(["width", "length", "diameter"]);

function readGrid(ws: ExcelJS.Worksheet): (string | number | null)[][] {
  const grid: (string | number | null)[][] = [];
  ws.eachRow({ includeEmpty: false }, (row, r) => {
    const cells: (string | number | null)[] = [];
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      const v = cell.value;
      cells[c - 1] = typeof v === "number" ? v : v == null ? null : typeof v === "object" && "result" in v ? (v.result as string | number) : String(v);
    });
    grid[r - 1] = cells;
  });
  return grid;
}

export async function importCompetitorSizes(buffer: Buffer): Promise<SizesImportResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("Workbook has no sheets");
  return importCompetitorSizesRows(readGrid(ws));
}

/**
 * Same import from a plain grid (CSV or Google Sheet). Header row first.
 * Recognised columns (loosely matched): Competitor Code · Manufacturer · Description ·
 * Width · Length · Diameter · Thickness (mm) · Unit (cm|mm|in, default cm) · Size (free text, e.g. "10 x 15 cm") · Notes.
 */
export async function importCompetitorSizesRows(grid: (string | number | null | undefined)[][]): Promise<SizesImportResult> {
  const header = grid[0] ?? [];
  const cols: Record<string, number> = {};
  header.forEach((cell, i) => {
    const l = String(cell ?? "").trim().toLowerCase();
    if (!l) return;
    if (/^(competitor\s*)?(code|cfn|catalog|product\s*code|sku|item|part)/.test(l)) cols.code ??= i + 1;
    else if (/^(manufacturer|vendor|company|competitor(\s*name)?)$/.test(l)) cols.manufacturer ??= i + 1;
    else if (/^(description|desc|product)/.test(l)) cols.description ??= i + 1;
    else if (/^width/.test(l)) cols.width ??= i + 1;
    else if (/^length/.test(l)) cols.length ??= i + 1;
    else if (/^diam/.test(l)) cols.diameter ??= i + 1;
    else if (/^thick/.test(l)) cols.thickness ??= i + 1;
    else if (/^unit/.test(l)) cols.unit ??= i + 1;
    else if (/^(size|dimensions?)$/.test(l)) cols.size ??= i + 1;
    else if (/^(notes?|comment)/.test(l)) cols.notes ??= i + 1;
  });
  if (!cols.code) throw new Error("Could not find a competitor code column (expected 'Competitor Code', 'CFN' or 'Product Code')");
  const at = (r: number, c?: number) => (c ? (grid[r] ?? [])[c - 1] ?? null : null);
  const num = (v: string | number | null | undefined) => {
    if (v == null || String(v).trim() === "") return null;
    const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const unitOf = (v: string | number | null | undefined, fallback: Dimension["unit"]): Dimension["unit"] => {
    const u = String(v ?? "").trim().toLowerCase().replace(/[."]/g, "");
    return u === "mm" ? "mm" : u === "cm" ? "cm" : u === "in" || u === "inch" || u === "inches" ? "in" : fallback;
  };

  let upserted = 0;
  let rows = 0;
  const skipped: string[] = [];
  const touched: string[] = [];
  for (let r = 1; r < grid.length; r++) {
    const raw = at(r, cols.code);
    // Keyed on the compact form so "UPA-31015", "UPA 31015" and "UPA31015" are one spec.
    const cfnNorm = compactCfn(normalizeCfn(raw));
    if (!cfnNorm) continue;
    rows++;
    const unit = unitOf(at(r, cols.unit), "cm");
    const dims: Dimension[] = [];
    const w = num(at(r, cols.width)), l = num(at(r, cols.length)), d = num(at(r, cols.diameter)), t = num(at(r, cols.thickness));
    if (w != null && l != null) dims.push({ name: "width", value: Math.min(w, l), unit }, { name: "length", value: Math.max(w, l), unit });
    else if (w != null) dims.push({ name: "width", value: w, unit });
    else if (l != null) dims.push({ name: "length", value: l, unit });
    if (d != null) dims.push({ name: "diameter", value: d, unit });
    if (t != null) dims.push({ name: "thickness", value: t, unit: "mm" });
    const free = String(at(r, cols.size) ?? "").trim();
    if (free) for (const x of extractDimensions(free)) if (!dims.some((y) => y.name === x.name)) dims.push(x);
    if (!dims.some((x) => SIZE_NAMES.has(x.name))) { skipped.push(String(raw)); continue; }

    const manufacturer = String(at(r, cols.manufacturer) ?? "").trim() || null;
    const description = String(at(r, cols.description) ?? "").trim() || null;
    const notes = String(at(r, cols.notes) ?? "").trim() || null;
    await prisma.competitorSpec.upsert({
      where: { cfnNorm },
      create: { cfnNorm, manufacturer, description, notes, dimsJson: JSON.stringify(dims) },
      update: { dimsJson: JSON.stringify(dims), ...(manufacturer ? { manufacturer } : {}), ...(description ? { description } : {}), ...(notes ? { notes } : {}) },
    });
    upserted++;
    touched.push(cfnNorm);
  }

  // Bins built before the sizes arrived are stale: clear them so the next run re-bins with the sizes.
  let rebinned = 0;
  if (touched.length) {
    const set = new Set(touched);
    const all = await prisma.competitorProduct.findMany({ select: { id: true, cfnNorm: true, cfnMatched: true } });
    const ids = all.filter((c) => set.has(compactCfn(c.cfnNorm)) || (c.cfnMatched && set.has(compactCfn(c.cfnMatched.toUpperCase())))).map((c) => c.id);
    if (ids.length) {
      const res = await prisma.competitorProduct.updateMany({ where: { id: { in: ids } }, data: { binJson: null, binSource: null, binnedAt: null } });
      rebinned = res.count;
    }
  }
  return { upserted, rows, skipped, rebinned };
}

/** Look up imported sizes for a competitor product by any of its code spellings. */
export async function specFor(codes: (string | null | undefined)[]): Promise<{ dims: Dimension[]; notes: string | null } | null> {
  const keys = [...new Set(codes.filter((c): c is string => Boolean(c)).map((c) => compactCfn(normalizeCfn(c))))].filter(Boolean);
  if (!keys.length) return null;
  const spec = await prisma.competitorSpec.findFirst({ where: { cfnNorm: { in: keys } }, orderBy: { updatedAt: "desc" } });
  if (!spec) return null;
  try { return { dims: JSON.parse(spec.dimsJson) as Dimension[], notes: spec.notes }; } catch { return null; }
}

export const SIZES_HEADERS = ["Competitor Code", "Manufacturer", "Description", "Width", "Length", "Diameter", "Thickness (mm)", "Unit", "Notes"] as const;

/**
 * Template rows: every competitor code Crosswalk has resolved whose bin still has no
 * width / length / diameter (blank cells to fill), followed by the sizes already on file.
 */
export async function competitorSizesTemplateRows(): Promise<{ rows: (string | number | null)[][]; missing: number; onFile: number }> {
  const [cps, specs] = await Promise.all([
    prisma.competitorProduct.findMany({ where: { resolution: { not: "not-found" } }, orderBy: [{ manufacturer: "asc" }, { cfnNorm: "asc" }] }),
    prisma.competitorSpec.findMany({ orderBy: [{ manufacturer: "asc" }, { cfnNorm: "asc" }] }),
  ]);
  const onFile = new Set(specs.map((s) => s.cfnNorm));
  const rows: (string | number | null)[][] = [[...SIZES_HEADERS]];
  let missing = 0;
  for (const cp of cps) {
    if (onFile.has(compactCfn(cp.cfnNorm)) || (cp.cfnMatched && onFile.has(compactCfn(cp.cfnMatched.toUpperCase())))) continue;
    const bin = parseBin(cp.binJson, { allowStale: true });
    if (bin && bin.dimensions.some((d) => SIZE_NAMES.has(d.name))) continue;
    missing++;
    rows.push([cp.cfnNorm, cp.manufacturer ?? "", cp.description ?? "", null, null, null, null, "cm", ""]);
  }
  for (const s of specs) {
    let dims: Dimension[] = [];
    try { dims = JSON.parse(s.dimsJson); } catch {}
    const get = (n: string) => dims.find((d) => d.name === n) ?? null;
    const unit = (get("width") ?? get("length") ?? get("diameter"))?.unit ?? "cm";
    rows.push([s.cfnNorm, s.manufacturer ?? "", s.description ?? "", get("width")?.value ?? null, get("length")?.value ?? null, get("diameter")?.value ?? null, get("thickness")?.value ?? null, unit, s.notes ?? ""]);
  }
  return { rows, missing, onFile: specs.length };
}

export async function competitorSizesTemplate(): Promise<Buffer> {
  const { rows, missing } = await competitorSizesTemplateRows();
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Competitor sizes");
  for (const r of rows) ws.addRow(r);
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE3F1EF" } };
  // Rows that still need a size get a soft amber fill so they stand out from the ones already on file.
  for (let i = 2; i <= missing + 1; i++) ws.getRow(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFDF3E1" } };
  ws.columns = SIZES_HEADERS.map((h) => ({ width: h === "Description" ? 60 : h === "Notes" ? 32 : 16 }));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}
