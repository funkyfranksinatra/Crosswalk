/** Writes the CHECK-constraint migration from src/lib/db/constraints.ts (see that file). */
import fs from "node:fs";
import path from "node:path";
import { migrationSql } from "../src/lib/db/constraints";
const dir = process.argv[2] ?? path.resolve(__dirname, "../prisma/migrations/20260919000100_tier0_check_constraints");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "migration.sql"), migrationSql());
console.log(`wrote ${path.join(dir, "migration.sql")}`);
