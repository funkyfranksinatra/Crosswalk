/**
 * Google Sheets / Drive integration, in two tiers.
 *
 *  Tier 1 — no credentials. Any Google Sheet shared as "Anyone with the link"
 *  can be read through its CSV export URL. This is what demos use.
 *
 *  Tier 2 — service account (optional). With GOOGLE_SERVICE_ACCOUNT_JSON set,
 *  Crosswalk can read private sheets shared with the service-account email and
 *  write exports into a Drive folder as native Google Sheets (the .xlsx we
 *  already build is uploaded with Drive's convert-on-upload, so tabs, number
 *  formats and colours survive). Free — needs a Google Cloud project with the
 *  Drive + Sheets APIs enabled and a folder shared with the service account.
 */
import fs from "node:fs";
import { JWT } from "google-auth-library";
import { parseCsv } from "./csv";

export type SheetRef = { spreadsheetId: string; gid: string | null; url: string };

/** Accepts a full Sheets URL (edit/view/pubhtml), a bare spreadsheet ID, or a Drive open?id= link. */
export function parseSheetLink(input: string): SheetRef | null {
  const s = input.trim();
  if (!s) return null;
  let id: string | null = null;
  const m = s.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/(?:e\/)?([a-zA-Z0-9-_]{20,})/);
  if (m) id = m[1];
  else {
    const q = s.match(/[?&]id=([a-zA-Z0-9-_]{20,})/);
    if (q) id = q[1];
    else if (/^[a-zA-Z0-9-_]{25,}$/.test(s)) id = s;
  }
  if (!id) return null;
  const gidM = s.match(/[#&?]gid=(\d+)/);
  return { spreadsheetId: id, gid: gidM ? gidM[1] : null, url: `https://docs.google.com/spreadsheets/d/${id}/edit${gidM ? `#gid=${gidM[1]}` : ""}` };
}

export class SheetAccessError extends Error {
  constructor(msg: string, public readonly hint: string) { super(msg); }
}

/** Tier 1: read a link-shared sheet as rows via the CSV export endpoint. */
export async function fetchPublicSheetRows(ref: SheetRef): Promise<{ rows: string[][]; title: string }> {
  const url = `https://docs.google.com/spreadsheets/d/${ref.spreadsheetId}/export?format=csv${ref.gid ? `&gid=${ref.gid}` : ""}`;
  const res = await fetch(url, { redirect: "follow", headers: { accept: "text/csv,*/*" }, cache: "no-store" });
  const ct = res.headers.get("content-type") ?? "";
  if (res.status === 401 || res.status === 403 || /text\/html/.test(ct) || res.url.includes("accounts.google.com")) {
    throw new SheetAccessError(
      "This sheet is not shared publicly.",
      googleConfigured()
        ? `Either share it as "Anyone with the link → Viewer", or share it with the service account ${serviceAccountEmail()} and Crosswalk will read it privately.`
        : 'Open the sheet in Google Sheets → Share → General access → "Anyone with the link" (Viewer), then paste the link again.',
    );
  }
  if (!res.ok) throw new SheetAccessError(`Google returned ${res.status} for that link.`, "Check the link is a Google Sheets URL.");
  const text = await res.text();
  const cd = res.headers.get("content-disposition") ?? "";
  const nm = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i);
  const title = nm ? decodeURIComponent(nm[1]).replace(/\.csv$/i, "") : `Google Sheet ${ref.spreadsheetId.slice(0, 8)}`;
  return { rows: parseCsv(text), title };
}

/** Reads a sheet: private via service account when configured, public CSV otherwise (falls back automatically). */
export async function fetchSheetRows(ref: SheetRef): Promise<{ rows: string[][]; title: string; via: "public" | "service-account" }> {
  if (googleConfigured()) {
    try {
      const r = await readPrivateSheet(ref);
      return { ...r, via: "service-account" };
    } catch (e) {
      if (!(e instanceof SheetAccessError)) throw e;
      // not shared with the service account — try the public route before giving up
    }
  }
  const r = await fetchPublicSheetRows(ref);
  return { ...r, via: "public" };
}

// ---------------------------------------------------------------------------
// Tier 2 — service account
// ---------------------------------------------------------------------------

type ServiceAccount = { client_email: string; private_key: string; project_id?: string };

let cachedSa: ServiceAccount | null | undefined;
function serviceAccount(): ServiceAccount | null {
  if (cachedSa !== undefined) return cachedSa;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return (cachedSa = null);
  try {
    const text = raw.startsWith("{") ? raw : fs.readFileSync(raw, "utf8");
    const j = JSON.parse(text);
    cachedSa = j.client_email && j.private_key ? { client_email: j.client_email, private_key: j.private_key, project_id: j.project_id } : null;
  } catch {
    cachedSa = null;
  }
  return cachedSa;
}

export function googleConfigured(): boolean {
  return serviceAccount() !== null;
}
export function serviceAccountEmail(): string | null {
  return serviceAccount()?.client_email ?? null;
}
export function driveFolderId(): string | null {
  const v = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim();
  if (!v) return null;
  const m = v.match(/folders\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : v;
}
export function googleStatus() {
  const sa = serviceAccount();
  return { configured: Boolean(sa), email: sa?.client_email ?? null, project: sa?.project_id ?? null, folderId: driveFolderId(), canWrite: Boolean(sa && driveFolderId()) };
}

const SCOPES = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets"];
let jwt: JWT | null = null;
async function token(): Promise<string> {
  const sa = serviceAccount();
  if (!sa) throw new Error("Google service account not configured");
  if (!jwt) jwt = new JWT({ email: sa.client_email, key: sa.private_key, scopes: SCOPES });
  const t = await jwt.getAccessToken();
  if (!t.token) throw new Error("Could not obtain a Google access token");
  return t.token;
}

async function gfetch(url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${await token()}`, ...(init.headers ?? {}) } });
  return res;
}

async function readPrivateSheet(ref: SheetRef): Promise<{ rows: string[][]; title: string }> {
  const meta = await gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${ref.spreadsheetId}?fields=properties.title,sheets.properties`);
  if (meta.status === 403 || meta.status === 404) throw new SheetAccessError("Sheet not shared with the service account.", `Share it with ${serviceAccountEmail()} (Viewer).`);
  if (!meta.ok) throw new Error(`Sheets API ${meta.status}: ${(await meta.text()).slice(0, 200)}`);
  const m = (await meta.json()) as { properties: { title: string }; sheets: { properties: { sheetId: number; title: string } }[] };
  const sheet = (ref.gid ? m.sheets.find((s) => String(s.properties.sheetId) === ref.gid) : null) ?? m.sheets[0];
  const range = encodeURIComponent(`'${sheet.properties.title.replace(/'/g, "''")}'`);
  const vals = await gfetch(`https://sheets.googleapis.com/v4/spreadsheets/${ref.spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE`);
  if (!vals.ok) throw new Error(`Sheets API ${vals.status}: ${(await vals.text()).slice(0, 200)}`);
  const v = (await vals.json()) as { values?: (string | number | boolean)[][] };
  return { rows: (v.values ?? []).map((r) => r.map((c) => (c == null ? "" : String(c)))), title: m.properties.title };
}

/**
 * Upload an .xlsx buffer to Drive as a native Google Sheet (convert-on-upload)
 * inside the configured folder. Returns the web link.
 */
export async function uploadXlsxAsGoogleSheet(buffer: Buffer, name: string, opts: { anyoneWithLink?: boolean } = {}): Promise<{ id: string; url: string }> {
  const folder = driveFolderId();
  if (!folder) throw new Error("GOOGLE_DRIVE_FOLDER_ID is not set");
  const boundary = "crosswalk" + Math.random().toString(36).slice(2);
  const metadata = { name: name.replace(/\.xlsx$/i, ""), mimeType: "application/vnd.google-apps.spreadsheet", parents: [folder] };
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const body = Buffer.concat([Buffer.from(head, "utf8"), buffer, Buffer.from(tail, "utf8")]);
  const res = await gfetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,webViewLink", {
    method: "POST",
    headers: { "content-type": `multipart/related; boundary=${boundary}`, "content-length": String(body.length) },
    body: new Uint8Array(body),
  });
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 404) throw new Error(`Drive folder ${folder} not found or not shared with ${serviceAccountEmail()} as Editor.`);
    throw new Error(`Drive upload failed (${res.status}): ${t.slice(0, 300)}`);
  }
  const file = (await res.json()) as { id: string; webViewLink: string };
  if (opts.anyoneWithLink) {
    await gfetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions?supportsAllDrives=true`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" }),
    }).catch(() => {});
  }
  return { id: file.id, url: file.webViewLink ?? `https://docs.google.com/spreadsheets/d/${file.id}/edit` };
}

/** Quick connectivity/permission check used by Settings. */
export async function googleSelfTest(): Promise<{ ok: boolean; message: string }> {
  if (!googleConfigured()) return { ok: false, message: "No service account configured." };
  try {
    const folder = driveFolderId();
    if (!folder) return { ok: false, message: `Token OK for ${serviceAccountEmail()}, but GOOGLE_DRIVE_FOLDER_ID is not set — reads work, Drive write-back is off.` };
    const res = await gfetch(`https://www.googleapis.com/drive/v3/files/${folder}?supportsAllDrives=true&fields=id,name,capabilities/canAddChildren`);
    if (!res.ok) return { ok: false, message: `Folder ${folder} is not accessible to ${serviceAccountEmail()} (${res.status}). Share it with that email as Editor.` };
    const f = (await res.json()) as { name: string; capabilities?: { canAddChildren?: boolean } };
    return f.capabilities?.canAddChildren === false
      ? { ok: false, message: `Folder “${f.name}” is shared read-only. Give ${serviceAccountEmail()} Editor access.` }
      : { ok: true, message: `Ready: exports will be written to Drive folder “${f.name}”.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
