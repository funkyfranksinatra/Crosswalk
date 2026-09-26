/** Writes the CHECK-constraint migration from src/lib/db/constraints.ts (see that file). */
import fs from "node:fs";
import path from "node:path";
import { migrationSql } from "../src/lib/db/constraints";
const targets: [string, 0 | 2 | 3][] = [[path.resolve(__dirname, "../prisma/migrations/20260919000100_tier0_check_constraints"), 0], [path.resolve(__dirname, "../prisma/migrations/20260923000002_tier2_check_constraints"), 2], [path.resolve(__dirname, "../prisma/migrations/20260925000001_curated_conflicts_check"), 3]];
for (const [dir, tier] of process.argv[2] ? [[process.argv[2], 0] as [string, 0 | 2 | 3]] : targets) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "migration.sql"), migrationSql(tier));
  console.log(`wrote ${path.join(dir, "migration.sql")}`);
}
