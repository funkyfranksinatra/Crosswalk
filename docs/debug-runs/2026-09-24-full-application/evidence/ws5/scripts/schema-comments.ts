// Compare each ENUM_CONSTRAINTS value list with the "// A | B | C" comment on that column in prisma/schema.prisma.
import fs from "node:fs";
import { ENUM_CONSTRAINTS } from "../../../../../../src/lib/db/constraints";
const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
const models = new Map<string, string>();
for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) models.set(m[1], m[2]);
let mismatches = 0;
for (const c of ENUM_CONSTRAINTS) {
  const body = models.get(c.table) ?? "";
  const line = body.split("\n").find((l) => new RegExp(`^\\s+${c.column}\\s`).test(l)) ?? "";
  const comment = line.split("//")[1]?.trim() ?? "";
  const listed = comment.split("|").map((s) => s.trim()).filter((s) => /^[A-Za-z_*][A-Za-z0-9_ -]*$/.test(s));
  const values = [...c.values];
  const missing = values.filter((v) => !listed.includes(v));
  const extra = listed.filter((v) => !values.includes(v));
  if (!comment) { console.log(`NO COMMENT  ${c.table}.${c.column}: constraint allows ${values.join(" | ")}`); continue; }
  if (missing.length || extra.length) { mismatches++; console.log(`MISMATCH    ${c.table}.${c.column}: comment "${comment}"\n              constraint ${values.join(" | ")}${missing.length ? `\n              missing from comment: ${missing.join(", ")}` : ""}${extra.length ? `\n              in comment but not allowed: ${extra.join(", ")}` : ""}`); }
}
console.log(`${mismatches} mismatching comment(s)`);
