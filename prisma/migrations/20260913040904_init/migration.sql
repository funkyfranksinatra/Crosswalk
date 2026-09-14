-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "labelers" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OwnProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "gudidSyncedAt" DATETIME,
    "binJson" TEXT,
    "binSource" TEXT,
    "binnedAt" DATETIME,
    "listPrice" REAL,
    "cogs" REAL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OwnProduct_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CompetitorProduct" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cfnNorm" TEXT NOT NULL,
    "cfnMatched" TEXT,
    "manufacturer" TEXT,
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
    "alternatesJson" TEXT,
    "binJson" TEXT,
    "binSource" TEXT,
    "binnedAt" DATETIME,
    "resolvedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "KnownCross" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Pricebook" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PriceEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pricebookId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "price" REAL NOT NULL,
    CONSTRAINT "PriceEntry_pricebookId_fkey" FOREIGN KEY ("pricebookId") REFERENCES "Pricebook" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PriceEntry_productId_fkey" FOREIGN KEY ("productId") REFERENCES "OwnProduct" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Request" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "companyId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "accountNumber" TEXT,
    "accountName" TEXT,
    "accountType" TEXT,
    "reportType" TEXT NOT NULL DEFAULT 'Competitive Cross Reference with Pricebook',
    "pricebookId" TEXT,
    "sourceFileName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "stage" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "useLlm" BOOLEAN NOT NULL DEFAULT true,
    "optionsJson" TEXT,
    "logJson" TEXT NOT NULL DEFAULT '[]',
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    CONSTRAINT "Request_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Request_pricebookId_fkey" FOREIGN KEY ("pricebookId") REFERENCES "Pricebook" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RequestLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "rawCode" TEXT NOT NULL,
    "cfnNorm" TEXT NOT NULL,
    "quantity" REAL NOT NULL,
    "estCompetitorPrice" REAL,
    "competitorProductId" TEXT,
    "resolutionStatus" TEXT NOT NULL DEFAULT 'pending',
    "resolutionNote" TEXT,
    "matchStatus" TEXT NOT NULL DEFAULT 'pending',
    "selectedCandidateId" TEXT,
    "overrideNote" TEXT,
    "reviewed" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "RequestLine_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RequestLine_competitorProductId_fkey" FOREIGN KEY ("competitorProductId") REFERENCES "CompetitorProduct" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MatchCandidate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lineId" TEXT NOT NULL,
    "ownProductId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "matchType" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "score" REAL NOT NULL,
    "scoreBin" REAL,
    "scorePrice" REAL,
    "scoreCogs" REAL,
    "scoreMargin" REAL,
    "factorsJson" TEXT,
    "rationale" TEXT,
    "additionalProducts" TEXT,
    "unitPrice" REAL,
    "extended" REAL,
    "isSelected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MatchCandidate_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "RequestLine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MatchCandidate_ownProductId_fkey" FOREIGN KEY ("ownProductId") REFERENCES "OwnProduct" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purpose" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "error" TEXT,
    "subject" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
