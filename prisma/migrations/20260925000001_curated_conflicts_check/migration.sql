-- Curated evidence conflicts: CHECK constraint on KnownCross.conflictStatus.
-- Generated from src/lib/db/constraints.ts by scripts/gen-constraints.ts — edit that file, not this one.

ALTER TABLE "KnownCross" DROP CONSTRAINT IF EXISTS "chk_KnownCross_conflictStatus";
ALTER TABLE "KnownCross" ADD CONSTRAINT "chk_KnownCross_conflictStatus" CHECK ("conflictStatus" IN ('CONTRADICTED', 'KEPT')) NOT VALID;
ALTER TABLE "KnownCross" VALIDATE CONSTRAINT "chk_KnownCross_conflictStatus";
