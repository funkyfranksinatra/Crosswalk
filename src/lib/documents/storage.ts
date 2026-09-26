/**
 * Where uploaded document bytes live so an extraction can be re-run and a reviewer can open
 * the source. Local directory by default (DOCUMENT_STORAGE_DIR, else ./.data/documents);
 * a deployment with object storage points the directory at a mounted bucket. Paths are
 * derived from the document id only — never from the uploaded file name.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

export function documentDir(): string { return process.env.DOCUMENT_STORAGE_DIR?.trim() || path.join(process.cwd(), ".data", "documents"); }
function fileFor(id: string): string { if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("invalid document id"); return path.join(documentDir(), id); }

export async function storeDocumentBytes(id: string, bytes: Buffer): Promise<string> {
  await mkdir(documentDir(), { recursive: true });
  const p = fileFor(id);
  await writeFile(p, bytes);
  return p;
}
export async function readDocumentBytes(id: string): Promise<Buffer | null> {
  const p = fileFor(id); // an invalid id is an error, never "not found"
  try { return await readFile(p); } catch { return null; }
}
