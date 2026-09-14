-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "labelers" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnProduct" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "brand" TEXT,
    "labeler" TEXT,
    "status" TEXT,
    "gudidDi" TEXT,
    "gmdnName" TEXT,
    "gmdnCode" TEXT,
    "fdaProductCode" TEXT,
    "gudidJson" TEXT,
    "gudidSyncedAt" TIMESTAMP(3),
    "binJson" TEXT,
    "binSource" TEXT,
    "binnedAt" TIMESTAMP(3),
    "listPrice" DECIMAL(18,4),
    "cogs" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OwnProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorProduct" (
    "id" TEXT NOT NULL,
    "cfnNorm" TEXT NOT NULL,
    "cfnMatched" TEXT,
    "manufacturer" TEXT,
    "labeler" TEXT,
    "brand" TEXT,
    "description" TEXT,
    "category" TEXT,
    "gudidDi" TEXT,
    "gmdnName" TEXT,
    "gmdnCode" TEXT,
    "fdaProductCode" TEXT,
    "status" TEXT,
    "gudidJson" TEXT,
    "resolution" TEXT NOT NULL,
    "resolutionNote" TEXT,
    "confidence" DOUBLE PRECISION,
    "alternatesJson" TEXT,
    "binJson" TEXT,
    "binSource" TEXT,
    "binnedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetitorProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorSpec" (
    "id" TEXT NOT NULL,
    "cfnNorm" TEXT NOT NULL,
    "manufacturer" TEXT,
    "description" TEXT,
    "dimsJson" TEXT NOT NULL,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'import',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetitorSpec_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnownCross" (
    "id" TEXT NOT NULL,
    "ownSku" TEXT NOT NULL,
    "ownDescription" TEXT,
    "category" TEXT,
    "competitorName" TEXT NOT NULL,
    "competitorCode" TEXT NOT NULL,
    "competitorCodeNorm" TEXT NOT NULL,
    "competitorDescription" TEXT,
    "matchType" TEXT NOT NULL,
    "preferredOwnSku" TEXT,
    "additionalProducts" TEXT,
    "notes" TEXT,
    "source" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnownCross_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pricebook" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Pricebook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceEntry" (
    "id" TEXT NOT NULL,
    "pricebookId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "price" DECIMAL(18,4) NOT NULL,

    CONSTRAINT "PriceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Request" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "accountNumber" TEXT,
    "accountName" TEXT,
    "accountType" TEXT,
    "reportType" TEXT NOT NULL DEFAULT 'Competitive Cross Reference with Pricebook',
    "pricebookId" TEXT,
    "sourceFileName" TEXT,
    "sourceUrl" TEXT,
    "xrefSheetUrl" TEXT,
    "offerSheetUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "stage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "useLlm" BOOLEAN NOT NULL DEFAULT true,
    "optionsJson" TEXT,
    "logJson" TEXT NOT NULL DEFAULT '[]',
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestLine" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "rawCode" TEXT NOT NULL,
    "cfnNorm" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "estCompetitorPrice" DECIMAL(18,4),
    "competitorProductId" TEXT,
    "resolutionStatus" TEXT NOT NULL DEFAULT 'pending',
    "resolutionNote" TEXT,
    "matchStatus" TEXT NOT NULL DEFAULT 'pending',
    "selectedCandidateId" TEXT,
    "overrideNote" TEXT,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RequestLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchCandidate" (
    "id" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "ownProductId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "matchType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "scoreBin" DOUBLE PRECISION,
    "scorePrice" DOUBLE PRECISION,
    "scoreCogs" DOUBLE PRECISION,
    "scoreMargin" DOUBLE PRECISION,
    "factorsJson" TEXT,
    "rationale" TEXT,
    "additionalProducts" TEXT,
    "unitPrice" DECIMAL(18,4),
    "extended" DECIMAL(18,4),
    "isSelected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MatchCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "error" TEXT,
    "subject" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmGrade" (
    "key" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "lines" INTEGER NOT NULL DEFAULT 1,
    "json" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmGrade_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_name_key" ON "Company"("name");

-- CreateIndex
CREATE INDEX "OwnProduct_category_idx" ON "OwnProduct"("category");

-- CreateIndex
CREATE UNIQUE INDEX "OwnProduct_companyId_sku_key" ON "OwnProduct"("companyId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorProduct_cfnNorm_key" ON "CompetitorProduct"("cfnNorm");

-- CreateIndex
CREATE UNIQUE INDEX "CompetitorSpec_cfnNorm_key" ON "CompetitorSpec"("cfnNorm");

-- CreateIndex
CREATE INDEX "KnownCross_competitorCodeNorm_idx" ON "KnownCross"("competitorCodeNorm");

-- CreateIndex
CREATE UNIQUE INDEX "KnownCross_ownSku_competitorCodeNorm_source_key" ON "KnownCross"("ownSku", "competitorCodeNorm", "source");

-- CreateIndex
CREATE UNIQUE INDEX "Pricebook_name_key" ON "Pricebook"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PriceEntry_pricebookId_productId_key" ON "PriceEntry"("pricebookId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "Request_reference_key" ON "Request"("reference");

-- CreateIndex
CREATE INDEX "RequestLine_requestId_lineNo_idx" ON "RequestLine"("requestId", "lineNo");

-- CreateIndex
CREATE INDEX "MatchCandidate_lineId_rank_idx" ON "MatchCandidate"("lineId", "rank");

-- AddForeignKey
ALTER TABLE "OwnProduct" ADD CONSTRAINT "OwnProduct_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceEntry" ADD CONSTRAINT "PriceEntry_pricebookId_fkey" FOREIGN KEY ("pricebookId") REFERENCES "Pricebook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceEntry" ADD CONSTRAINT "PriceEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "OwnProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_pricebookId_fkey" FOREIGN KEY ("pricebookId") REFERENCES "Pricebook"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestLine" ADD CONSTRAINT "RequestLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestLine" ADD CONSTRAINT "RequestLine_competitorProductId_fkey" FOREIGN KEY ("competitorProductId") REFERENCES "CompetitorProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchCandidate" ADD CONSTRAINT "MatchCandidate_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "RequestLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchCandidate" ADD CONSTRAINT "MatchCandidate_ownProductId_fkey" FOREIGN KEY ("ownProductId") REFERENCES "OwnProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

