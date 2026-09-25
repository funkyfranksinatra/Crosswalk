-- Evidence conflicts on curated crosses: a run whose product attributes contradict a curated row
-- records the findings on the row itself, so the review happens in Crosswalk (Crosswalk → Evidence
-- conflicts) instead of in a spreadsheet. Additive; nothing is dropped.
ALTER TABLE "KnownCross" ADD COLUMN "conflictStatus" TEXT;
ALTER TABLE "KnownCross" ADD COLUMN "conflictJson" TEXT;
ALTER TABLE "KnownCross" ADD COLUMN "conflictCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "KnownCross" ADD COLUMN "conflictSeenAt" TIMESTAMP(3);
ALTER TABLE "KnownCross" ADD COLUMN "conflictDecidedByUserId" TEXT;
ALTER TABLE "KnownCross" ADD COLUMN "conflictDecidedAt" TIMESTAMP(3);
ALTER TABLE "KnownCross" ADD COLUMN "conflictNote" TEXT;
CREATE INDEX "KnownCross_conflictStatus_idx" ON "KnownCross"("conflictStatus");
