-- Tier 3 — product and scale.
-- pgvector: Neon, the CI image (pgvector/pgvector) and a local Postgres with the extension package all provide it.
CREATE EXTENSION IF NOT EXISTS vector;


-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "shipToJson" TEXT,
ADD COLUMN     "taxExempt" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "taxExemptionNo" TEXT;

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "onBehalfOfUserId" TEXT;

-- AlterTable
ALTER TABLE "CompetitorProduct" ADD COLUMN     "embeddedAt" TIMESTAMP(3),
ADD COLUMN     "embedding" vector(1536),
ADD COLUMN     "embeddingHash" TEXT,
ADD COLUMN     "embeddingModel" TEXT;

-- AlterTable
ALTER TABLE "OwnProduct" ADD COLUMN     "embeddedAt" TIMESTAMP(3),
ADD COLUMN     "embedding" vector(1536),
ADD COLUMN     "embeddingHash" TEXT,
ADD COLUMN     "embeddingModel" TEXT;

-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN     "freightAmount" DECIMAL(18,4),
ADD COLUMN     "freightMode" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "freightValue" DECIMAL(18,4),
ADD COLUMN     "shipToJson" TEXT,
ADD COLUMN     "taxAmount" DECIMAL(18,4),
ADD COLUMN     "taxCalculatedAt" TIMESTAMP(3),
ADD COLUMN     "taxDetailJson" TEXT,
ADD COLUMN     "taxExemptionNo" TEXT,
ADD COLUMN     "taxMode" TEXT NOT NULL DEFAULT 'NONE',
ADD COLUMN     "taxProvider" TEXT,
ADD COLUMN     "taxRate" DECIMAL(12,6);

-- AlterTable
ALTER TABLE "ProposalLine" ADD COLUMN     "customerNote" TEXT;

-- AlterTable
ALTER TABLE "RequestLine" ADD COLUMN     "customerNote" TEXT;

-- CreateTable
CREATE TABLE "ApprovalDelegation" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdByUserId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApprovalDelegation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsSnapshot" (
    "id" TEXT NOT NULL,
    "report" TEXT NOT NULL,
    "json" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trigger" TEXT NOT NULL DEFAULT 'schedule',

    CONSTRAINT "AnalyticsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicAward" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT,
    "agency" TEXT,
    "awardee" TEXT,
    "awardeeId" TEXT,
    "naics" TEXT,
    "psc" TEXT,
    "amount" DECIMAL(18,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "awardDate" TIMESTAMP(3),
    "postedDate" TIMESTAMP(3),
    "description" TEXT,
    "url" TEXT,
    "competitorId" TEXT,
    "keywordsMatched" TEXT,
    "rawJson" TEXT,
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PublicAward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovalDelegation_toUserId_startsAt_endsAt_idx" ON "ApprovalDelegation"("toUserId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "ApprovalDelegation_fromUserId_idx" ON "ApprovalDelegation"("fromUserId");

-- CreateIndex
CREATE INDEX "AnalyticsSnapshot_report_computedAt_idx" ON "AnalyticsSnapshot"("report", "computedAt");

-- CreateIndex
CREATE INDEX "PublicAward_awardDate_idx" ON "PublicAward"("awardDate");

-- CreateIndex
CREATE INDEX "PublicAward_competitorId_idx" ON "PublicAward"("competitorId");

-- CreateIndex
CREATE UNIQUE INDEX "PublicAward_source_externalId_key" ON "PublicAward"("source", "externalId");

-- AddForeignKey
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDelegation" ADD CONSTRAINT "ApprovalDelegation_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Approximate nearest-neighbour index for the catalog side (the query side is one vector per line).
CREATE INDEX "OwnProduct_embedding_idx" ON "OwnProduct" USING hnsw ("embedding" vector_cosine_ops);
