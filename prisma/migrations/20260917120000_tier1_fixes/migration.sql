-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;

-- CreateIndex
CREATE INDEX "Notification_userId_dedupeKey_createdAt_idx" ON "Notification"("userId", "dedupeKey", "createdAt");
