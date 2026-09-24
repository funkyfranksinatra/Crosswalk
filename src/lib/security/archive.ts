/**
 * Decompression-bomb guard for uploaded spreadsheets (an .xlsx is a zip). ExcelJS inflates every
 * part into memory, so a 20 MB upload whose sharedStrings.xml deflates 1000:1 would ask for
 * gigabytes. Before a workbook is handed to the parser, the zip's central directory (which the
 * writer must fill in for any reader to open the file) is walked and the declared inflated
 * sizes summed. Pure; the upload routes call `assertSafeArchive`.
 *
 * Limits: total inflated ≤ MAX_INFLATED_BYTES (256 MB), any one entry ≤ MAX_ENTRY_BYTES (128 MB),
 * inflated/compressed ratio ≤ MAX_RATIO (200:1) once the archive is above a small floor, and at
 * most MAX_ENTRIES parts. A buffer that is not a zip is left to the parser (CSV, corrupt file).
 */
const EOCD = 0x06054b50, CEN = 0x02014b50, ZIP64_EOCD_LOC = 0x07064b50, ZIP64_EOCD = 0x06064b50;
export const MAX_INFLATED_BYTES = 256 * 1024 * 1024;
export const MAX_ENTRY_BYTES = 128 * 1024 * 1024;
export const MAX_RATIO = 200;
export const MAX_ENTRIES = 10_000;
const RATIO_FLOOR = 1024 * 1024; // below 1 MB inflated the ratio is irrelevant

export type ArchiveStats = { entries: number; compressed: number; inflated: number; largest: number; largestName: string; zip: boolean };

/** Sum the declared sizes from the central directory. `zip: false` when the buffer is not a zip. */
export function archiveStats(buf: Buffer): ArchiveStats {
  const none: ArchiveStats = { entries: 0, compressed: 0, inflated: 0, largest: 0, largestName: "", zip: false };
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return none;
  // End-of-central-directory record: within the last 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  if (eocd < 0) throw new Error("archive has no central directory");
  let count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64: the locator precedes the EOCD and points at the zip64 EOCD record.
    const loc = eocd - 20;
    if (loc < 0 || buf.readUInt32LE(loc) !== ZIP64_EOCD_LOC) throw new Error("archive declares zip64 without a locator");
    const z = Number(buf.readBigUInt64LE(loc + 8));
    if (z + 56 > buf.length || buf.readUInt32LE(z) !== ZIP64_EOCD) throw new Error("archive zip64 record out of range");
    count = Number(buf.readBigUInt64LE(z + 32)); cdSize = Number(buf.readBigUInt64LE(z + 40)); cdOffset = Number(buf.readBigUInt64LE(z + 48));
  }
  if (count > MAX_ENTRIES) throw new Error(`archive has too many parts (${count})`);
  if (cdOffset + cdSize > buf.length) throw new Error("archive central directory out of range");
  const out: ArchiveStats = { entries: 0, compressed: 0, inflated: 0, largest: 0, largestName: "", zip: true };
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new Error("archive central directory is corrupt");
    let csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (usize === 0xffffffff || csize === 0xffffffff) {
      // zip64 extra field 0x0001: [uncompressed u64][compressed u64]… only the fields that were 0xffffffff are present, in that order.
      let e = p + 46 + nameLen; const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e), len = buf.readUInt16LE(e + 2); let f = e + 4;
        if (id === 1) { if (usize === 0xffffffff && f + 8 <= end) { usize = Number(buf.readBigUInt64LE(f)); f += 8; } if (csize === 0xffffffff && f + 8 <= end) { csize = Number(buf.readBigUInt64LE(f)); f += 8; } break; }
        e += 4 + len;
      }
    }
    out.entries++; out.compressed += csize; out.inflated += usize;
    if (usize > out.largest) { out.largest = usize; out.largestName = name; }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Throws a plain Error (→ 400 in the routes) when the archive would inflate beyond the limits. */
export function assertSafeArchive(buf: Buffer, label = "file"): ArchiveStats {
  const s = archiveStats(buf);
  if (!s.zip) return s;
  if (s.inflated > MAX_INFLATED_BYTES) throw new Error(`${label} would expand to ${Math.round(s.inflated / 1048576)} MB (limit ${MAX_INFLATED_BYTES / 1048576} MB)`);
  if (s.largest > MAX_ENTRY_BYTES) throw new Error(`${label} contains a part (${s.largestName}) of ${Math.round(s.largest / 1048576)} MB (limit ${MAX_ENTRY_BYTES / 1048576} MB)`);
  if (s.inflated > RATIO_FLOOR && s.compressed > 0 && s.inflated / s.compressed > MAX_RATIO) throw new Error(`${label} has an implausible compression ratio (${Math.round(s.inflated / s.compressed)}:1)`);
  return s;
}
