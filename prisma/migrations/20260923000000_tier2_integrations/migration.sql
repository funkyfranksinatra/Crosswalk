-- Tier 2: integration layer — configuration, sync jobs, review queue, document extraction, inbound events, provenance columns.
-- DropIndex

-- AlterTable
ALTER TABLE "CompetitorPriceObservation" ADD COLUMN     "competitorDescription" TEXT,
ADD COLUMN     "contractRef" TEXT,
ADD COLUMN     "sourceOwner" TEXT,
ADD COLUMN     "sourceSystem" TEXT,
ADD COLUMN     "syncJobId" TEXT,
ADD COLUMN     "tier" TEXT,
ADD COLUMN     "validTo" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ExchangeRate" ADD COLUMN     "enteredByUserId" TEXT,
ADD COLUMN     "fetchedAt" TIMESTAMP(3),
ADD COLUMN     "syncJobId" TEXT;

-- AlterTable
ALTER TABLE "ExternalRef" ADD COLUMN     "mappingVersion" INTEGER,
ADD COLUMN     "metaJson" TEXT,
ADD COLUMN     "sourceUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "syncJobId" TEXT;

-- AlterTable
ALTER TABLE "GpoMembership" ADD COLUMN     "addressJson" TEXT,
ADD COLUMN     "externalMembershipId" TEXT,
ADD COLUMN     "memberName" TEXT,
ADD COLUMN     "syncJobId" TEXT;

-- CreateTable
CREATE TABLE "IntegrationConfig" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "configJson" TEXT NOT NULL DEFAULT '{}',
    "secretsJson" TEXT,
    "mappingJson" TEXT NOT NULL DEFAULT '{}',
    "scheduleCron" TEXT,
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastConnectedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "lastErrorCategory" TEXT,
    "cursorJson" TEXT,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSyncJob" (
    "id" TEXT NOT NULL,
    "integrationKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "syncType" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "received" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "errored" INTEGER NOT NULL DEFAULT 0,
    "reviewed" INTEGER NOT NULL DEFAULT 0,
    "errorSummary" TEXT,
    "errorCategory" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "cursorBefore" TEXT,
    "cursorAfter" TEXT,
    "reportJson" TEXT,
    "queueJobId" TEXT,
    "actorUserId" TEXT,

    CONSTRAINT "IntegrationSyncJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSyncError" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "externalId" TEXT,
    "category" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "rowRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationSyncError_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationReviewItem" (
    "id" TEXT NOT NULL,
    "integrationKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "syncJobId" TEXT,
    "externalId" TEXT,
    "dedupeKey" TEXT,
    "summary" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "suggestionJson" TEXT,
    "resolution" TEXT,
    "resolutionJson" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentExtraction" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "documentType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "overallConfidence" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "requestedByUserId" TEXT,
    "syncJobId" TEXT,
    "error" TEXT,
    "rawJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "DocumentExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedField" (
    "id" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'HEADER',
    "lineNo" INTEGER,
    "field" TEXT NOT NULL,
    "rawValue" TEXT,
    "normalizedValue" TEXT,
    "confidence" DOUBLE PRECISION,
    "page" INTEGER,
    "section" TEXT,
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "correctedValue" TEXT,
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "ExtractedField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationInboundEvent" (
    "id" TEXT NOT NULL,
    "integrationKey" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'RECEIVED',
    "error" TEXT,
    "payloadHash" TEXT,
    "summaryJson" TEXT,

    CONSTRAINT "IntegrationInboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationConfig_key_key" ON "IntegrationConfig"("key");

-- CreateIndex
CREATE INDEX "IntegrationSyncJob_integrationKey_startedAt_idx" ON "IntegrationSyncJob"("integrationKey", "startedAt");

-- CreateIndex
CREATE INDEX "IntegrationSyncJob_status_startedAt_idx" ON "IntegrationSyncJob"("status", "startedAt");

-- CreateIndex
CREATE INDEX "IntegrationSyncError_jobId_idx" ON "IntegrationSyncError"("jobId");

-- CreateIndex
CREATE INDEX "IntegrationReviewItem_integrationKey_status_createdAt_idx" ON "IntegrationReviewItem"("integrationKey", "status", "createdAt");

-- CreateIndex
CREATE INDEX "IntegrationReviewItem_dedupeKey_status_idx" ON "IntegrationReviewItem"("dedupeKey", "status");

-- CreateIndex
CREATE INDEX "DocumentExtraction_documentId_createdAt_idx" ON "DocumentExtraction"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "DocumentExtraction_status_idx" ON "DocumentExtraction"("status");

-- CreateIndex
CREATE INDEX "ExtractedField_extractionId_lineNo_idx" ON "ExtractedField"("extractionId", "lineNo");

-- CreateIndex
CREATE INDEX "IntegrationInboundEvent_integrationKey_receivedAt_idx" ON "IntegrationInboundEvent"("integrationKey", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationInboundEvent_integrationKey_eventId_key" ON "IntegrationInboundEvent"("integrationKey", "eventId");

-- CreateIndex
CREATE INDEX "ExchangeRate_fromCurrency_toCurrency_asOf_idx" ON "ExchangeRate"("fromCurrency", "toCurrency", "asOf");

-- CreateIndex
CREATE INDEX "GpoMembership_gpoId_externalMembershipId_idx" ON "GpoMembership"("gpoId", "externalMembershipId");

-- AddForeignKey
ALTER TABLE "IntegrationSyncJob" ADD CONSTRAINT "IntegrationSyncJob_integrationKey_fkey" FOREIGN KEY ("integrationKey") REFERENCES "IntegrationConfig"("key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSyncError" ADD CONSTRAINT "IntegrationSyncError_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "IntegrationSyncJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedField" ADD CONSTRAINT "ExtractedField_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "DocumentExtraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

