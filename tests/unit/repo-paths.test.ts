/**
 * Every tracked path must check out on Windows, macOS and Linux. Windows refuses < > : " | ? * \
 * and control characters in a name, a name ending in a dot or a space, and the reserved device
 * names (CON, PRN, AUX, NUL, COM1–9, LPT1–9, with or without an extension). A colon in twenty
 * evidence log names ("…-eval:gate.log") stopped `git merge` on the Windows checkout (Sept 26).
 * Also: two paths that differ only by case collide on the default Windows and macOS file systems.
 */
import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
function tracked(): string[] | null {
  try { return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean); }
  catch { return null; } // not a git checkout (e.g. a source tarball): nothing to check
}
const files = tracked();

describe.skipIf(!files)("tracked paths are portable", () => {
  test("no segment Windows cannot create", () => {
    const bad = (files ?? []).filter((f) => f.split("/").some((seg) => /[<>:"|?*\\\x00-\x1f]/.test(seg) || /[. ]$/.test(seg) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(seg)));
    expect(bad).toEqual([]);
  });
  test("no two paths differ only by case", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const f of files ?? []) { const k = f.toLowerCase(); if (seen.has(k) && seen.get(k) !== f) clashes.push(`${seen.get(k)} ↔ ${f}`); else seen.set(k, f); }
    expect(clashes).toEqual([]);
  });
});
