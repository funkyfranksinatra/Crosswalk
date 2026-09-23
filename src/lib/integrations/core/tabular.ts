/**
 * Read CSV / XLSX into header-keyed rows for the file-based providers (GPO rosters, competitor
 * contract prices). Sources: a file in INTEGRATION_FEED_DIR or a configured directory, an
 * uploaded buffer, or an SFTP drop (optional `ssh2-sftp-client`, loaded only when configured).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import { parseCsv } from "@/lib/sheets/csv";
import { ConfigurationError, ProviderUnavailableError, ValidationError } from "./errors";

export type Grid = (string | number | null)[][];
export type Row = Record<string, string | number | null>;

export function gridFromCsv(text: string): Grid { return parseCsv(text.replace(/^﻿/, "")); }

export async function gridFromXlsx(buffer: Buffer, sheet?: string | null): Promise<Grid> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = (sheet ? wb.getWorksheet(sheet) : null) ?? wb.worksheets[0];
  if (!ws) throw new ValidationError(sheet ? `Workbook has no sheet named "${sheet}"` : "Workbook has no sheets", { retryable: false });
  const grid: Grid = [];
  ws.eachRow({ includeEmpty: false }, (row, r) => { const cells: (string | number | null)[] = []; row.eachCell({ includeEmpty: true }, (cell, c) => { const v = cell.value; cells[c - 1] = typeof v === "number" ? v : v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "object" && "result" in v ? (v.result as string | number) : typeof v === "object" && "text" in v ? String((v as { text: string }).text) : String(v); }); grid[r - 1] = cells; });
  return grid.filter(Boolean);
}

export async function gridFromBuffer(buffer: Buffer, filename: string, sheet?: string | null): Promise<Grid> {
  return /\.xlsx?$/i.test(filename) ? gridFromXlsx(buffer, sheet) : gridFromCsv(buffer.toString("utf8"));
}

/** Header row → objects; `headerRow` is 1-based; blank rows dropped; headers trimmed. */
export function rowsFromGrid(grid: Grid, headerRow = 1): { headers: string[]; rows: Row[] } {
  const hi = Math.max(0, headerRow - 1);
  const headers = (grid[hi] ?? []).map((h) => String(h ?? "").trim());
  const rows: Row[] = [];
  for (let r = hi + 1; r < grid.length; r++) {
    const g = grid[r] ?? [];
    if (!g.some((c) => c !== null && c !== undefined && String(c).trim() !== "")) continue;
    const row: Row = { __row: r + 1 };
    headers.forEach((h, i) => { if (h) row[h] = g[i] === undefined ? null : typeof g[i] === "string" ? (g[i] as string).trim() : g[i]; });
    rows.push(row);
  }
  return { headers: headers.filter(Boolean), rows };
}

export type FileSource = { kind: "directory"; directory: string; pattern: string } | { kind: "sftp"; host: string; port?: number; username: string; password?: string | null; privateKey?: string | null; directory: string; pattern: string } | { kind: "upload"; filename: string; buffer: Buffer };

export type LocatedFile = { name: string; buffer: Buffer; hash: string; modifiedAt: Date | null };

/** Find the newest file matching the pattern (glob-lite: `*` and `?`). */
export async function locateFile(src: FileSource): Promise<LocatedFile | null> {
  if (src.kind === "upload") return { name: src.filename, buffer: src.buffer, hash: sha(src.buffer), modifiedAt: null };
  const re = globToRegex(src.pattern);
  if (src.kind === "directory") {
    const dir = path.resolve(src.directory);
    if (!fs.existsSync(dir)) throw new ConfigurationError(`Directory ${src.directory} does not exist on this server`);
    const candidates = fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m);
    if (!candidates.length) return null;
    const buffer = fs.readFileSync(path.join(dir, candidates[0].f));
    return { name: candidates[0].f, buffer, hash: sha(buffer), modifiedAt: new Date(candidates[0].m) };
  }
  // SFTP: optional dependency, resolved at call time so the app never needs it installed.
  let Client: new () => { connect(o: object): Promise<void>; list(dir: string): Promise<{ name: string; modifyTime: number; type: string }[]>; get(p: string): Promise<Buffer>; end(): Promise<void> };
  try { Client = ((await import(/* webpackIgnore: true */ "ssh2-sftp-client" as string)) as { default: typeof Client }).default; } catch { throw new ConfigurationError("SFTP delivery needs the optional package ssh2-sftp-client (npm install ssh2-sftp-client)"); }
  const sftp = new Client();
  try {
    await sftp.connect({ host: src.host, port: src.port ?? 22, username: src.username, password: src.password ?? undefined, privateKey: src.privateKey ?? undefined, readyTimeout: 15_000 });
    const entries = (await sftp.list(src.directory)).filter((e) => e.type === "-" && re.test(e.name)).sort((a, b) => b.modifyTime - a.modifyTime);
    if (!entries.length) return null;
    const buffer = await sftp.get(path.posix.join(src.directory, entries[0].name));
    return { name: entries[0].name, buffer, hash: sha(buffer), modifiedAt: new Date(entries[0].modifyTime) };
  } catch (e) {
    if (e instanceof ConfigurationError) throw e;
    throw new ProviderUnavailableError(`SFTP ${src.host}: ${(e as Error).message.replace(/password.*$/i, "[redacted]")}`);
  } finally { await sftp.end().catch(() => undefined); }
}

export function globToRegex(p: string): RegExp { return new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i"); }
export const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
