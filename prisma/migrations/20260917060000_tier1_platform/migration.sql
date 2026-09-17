-- AlterTable
ALTER TABLE "CompetitorProduct" ADD COLUMN     "gudidCheckedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "GudidImport" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cursorJson" TEXT,
ADD COLUMN     "jobId" TEXT;

-- AlterTable
ALTER TABLE "Request" ADD COLUMN     "attempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "checkpoint" TEXT,
ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "jobId" TEXT;

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "readAt" TIMESTAMP(3),
    "deliveriesJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "inApp" BOOLEAN NOT NULL DEFAULT true,
    "email" BOOLEAN NOT NULL DEFAULT true,
    "teams" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("userId","kind")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,
    "firstFiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastFiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastNotifiedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "contextJson" TEXT,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeedRun" (
    "id" TEXT NOT NULL,
    "feed" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "sourceRef" TEXT,
    "sourceHash" TEXT,
    "rows" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "reportJson" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "jobId" TEXT,

    CONSTRAINT "FeedRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenchmarkRun" (
    "id" TEXT NOT NULL,
    "label" TEXT,
    "model" TEXT,
    "promptVersion" INTEGER,
    "binVersion" INTEGER,
    "gitRef" TEXT,
    "cases" INTEGER NOT NULL,
    "lines" INTEGER NOT NULL,
    "resolved" INTEGER NOT NULL,
    "top1" INTEGER NOT NULL,
    "top3" INTEGER NOT NULL,
    "tierAgree" INTEGER NOT NULL,
    "byFamilyJson" TEXT NOT NULL,
    "byCaseJson" TEXT NOT NULL,
    "missesJson" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BenchmarkRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelEval" (
    "id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" INTEGER NOT NULL,
    "binVersion" INTEGER NOT NULL,
    "sampleSeed" INTEGER NOT NULL,
    "sampleSize" INTEGER NOT NULL,
    "graded" INTEGER NOT NULL,
    "top1Agree" INTEGER NOT NULL,
    "tierAgree" INTEGER NOT NULL,
    "noMatchFalse" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "costTokens" INTEGER,
    "accepted" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "detailJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelEval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_entityType_entityId_idx" ON "Notification"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_fingerprint_key" ON "Alert"("fingerprint");

-- CreateIndex
CREATE INDEX "Alert_resolvedAt_severity_idx" ON "Alert"("resolvedAt", "severity");

-- CreateIndex
CREATE INDEX "FeedRun_feed_startedAt_idx" ON "FeedRun"("feed", "startedAt");

-- CreateIndex
CREATE INDEX "BenchmarkRun_createdAt_idx" ON "BenchmarkRun"("createdAt");

-- CreateIndex
CREATE INDEX "ModelEval_model_promptVersion_createdAt_idx" ON "ModelEval"("model", "promptVersion", "createdAt");

-- CreateIndex
CREATE INDEX "CompetitorProduct_gudidCheckedAt_idx" ON "CompetitorProduct"("gudidCheckedAt");

-- CreateIndex
CREATE INDEX "Request_status_idx" ON "Request"("status");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
