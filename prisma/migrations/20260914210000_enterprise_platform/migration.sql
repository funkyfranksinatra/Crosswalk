-- DropIndex
DROP INDEX "PriceEntry_pricebookId_productId_key";

-- AlterTable
ALTER TABLE "KnownCross" ADD COLUMN     "accountId" TEXT,
ADD COLUMN     "approvalStatus" TEXT NOT NULL DEFAULT 'APPROVED',
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedByUserId" TEXT,
ADD COLUMN     "approvedUsage" TEXT,
ADD COLUMN     "clinicalReviewStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "effectiveFrom" TIMESTAMP(3),
ADD COLUMN     "effectiveTo" TIMESTAMP(3),
ADD COLUMN     "equivalenceLevel" TEXT NOT NULL DEFAULT 'FUNCTIONAL',
ADD COLUMN     "evidenceJson" TEXT,
ADD COLUMN     "justification" TEXT,
ADD COLUMN     "marketingReviewStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "reviewerUserId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "PriceEntry" ADD COLUMN     "accountId" TEXT,
ADD COLUMN     "approvalState" TEXT NOT NULL DEFAULT 'APPROVED',
ADD COLUMN     "contractId" TEXT,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN     "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "effectiveTo" TIMESTAMP(3),
ADD COLUMN     "gpoId" TEXT,
ADD COLUMN     "maxQty" DECIMAL(18,4),
ADD COLUMN     "minQty" DECIMAL(18,4),
ADD COLUMN     "productFamily" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'import',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "tier" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "volumeTierName" TEXT,
ALTER COLUMN "pricebookId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Request" ADD COLUMN     "accountId" TEXT;

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "externalId" TEXT,
    "territory" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,

    CONSTRAINT "UserRole_pkey" PRIMARY KEY ("userId","role")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accountNumber" TEXT,
    "type" TEXT NOT NULL DEFAULT 'SOLD_TO',
    "parentAccountId" TEXT,
    "territory" TEXT,
    "segment" TEXT,
    "region" TEXT,
    "country" TEXT NOT NULL DEFAULT 'US',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "isStrategic" BOOLEAN NOT NULL DEFAULT false,
    "ownerUserId" TEXT,
    "externalCrmId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gpo" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Gpo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GpoMembership" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "gpoId" TEXT NOT NULL,
    "tier" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GpoMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'Prospecting',
    "ownerUserId" TEXT,
    "closeDate" TIMESTAMP(3),
    "amount" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "externalCrmId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "contractNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "accountId" TEXT,
    "parentAccountId" TEXT,
    "gpoId" TEXT,
    "tier" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "precedence" INTEGER NOT NULL DEFAULT 0,
    "committedVolume" DECIMAL(18,4),
    "committedValue" DECIMAL(18,4),
    "renewalJson" TEXT,
    "priceProtectionJson" TEXT,
    "escalationJson" TEXT,
    "notes" TEXT,
    "sourceSystem" TEXT NOT NULL DEFAULT 'crosswalk',
    "externalId" TEXT,
    "ownerUserId" TEXT,
    "performanceJson" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractScope" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "productFamily" TEXT,
    "productId" TEXT,

    CONSTRAINT "ContractScope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractCommitment" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "productFamily" TEXT,
    "productId" TEXT,
    "committedUnits" DECIMAL(18,4),
    "committedValue" DECIMAL(18,4),
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractCommitment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RebateSchedule" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "productFamily" TEXT,
    "tiersJson" TEXT NOT NULL,
    "periodMonths" INTEGER NOT NULL DEFAULT 12,
    "notes" TEXT,

    CONSTRAINT "RebateSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleTerm" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "conditionJson" TEXT NOT NULL,
    "benefitJson" TEXT NOT NULL,

    CONSTRAINT "BundleTerm_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StandardCost" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "plant" TEXT,
    "region" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "costType" TEXT NOT NULL DEFAULT 'STANDARD',
    "cost" DECIMAL(18,4) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'import',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StandardCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExchangeRate" (
    "id" TEXT NOT NULL,
    "fromCurrency" TEXT NOT NULL,
    "toCurrency" TEXT NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExchangeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorUserId" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "beforeJson" TEXT,
    "afterJson" TEXT,
    "reason" TEXT,
    "contextJson" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Competitor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "aliasesJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Competitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT,
    "storagePath" TEXT,
    "uploadedByUserId" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "extractedJson" TEXT,
    "extractionConfidence" DOUBLE PRECISION,
    "notes" TEXT,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorPriceObservation" (
    "id" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "competitorSku" TEXT NOT NULL,
    "competitorProductId" TEXT,
    "price" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "uom" TEXT NOT NULL DEFAULT 'EA',
    "accountId" TEXT,
    "gpoId" TEXT,
    "region" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "effectiveAt" TIMESTAMP(3),
    "sourceType" TEXT NOT NULL,
    "sourceRef" TEXT,
    "documentId" TEXT,
    "enteredByUserId" TEXT,
    "rawConfidence" DOUBLE PRECISION NOT NULL,
    "verificationStatus" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedByUserId" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "notes" TEXT,
    "proposalLineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorPriceObservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingPolicy" (
    "id" TEXT NOT NULL,
    "productFamily" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "name" TEXT,
    "targetMarginPct" DECIMAL(7,4) NOT NULL,
    "minMarginPct" DECIMAL(7,4) NOT NULL,
    "floorMethod" TEXT NOT NULL DEFAULT 'COST_PLUS_MIN_MARGIN',
    "floorParamsJson" TEXT NOT NULL DEFAULT '{}',
    "defaultStrategy" TEXT NOT NULL DEFAULT 'MATCH',
    "defaultAdjustmentPct" DECIMAL(7,4) NOT NULL DEFAULT 0,
    "classification" TEXT NOT NULL DEFAULT 'DIFFERENTIATED',
    "strategicImportance" INTEGER NOT NULL DEFAULT 3,
    "authorityJson" TEXT NOT NULL,
    "approvalRulesJson" TEXT NOT NULL DEFAULT '[]',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PricingPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "parentProposalId" TEXT,
    "requestId" TEXT,
    "accountId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "gpoIdSnapshot" TEXT,
    "gpoNameSnapshot" TEXT,
    "contractId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "validThrough" TIMESTAMP(3),
    "ownerUserId" TEXT,
    "policyVersionsJson" TEXT NOT NULL DEFAULT '{}',
    "crosswalkVersionId" TEXT,
    "economicsJson" TEXT,
    "objectivesJson" TEXT,
    "lockedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProposalLine" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "included" BOOLEAN NOT NULL DEFAULT true,
    "competitorCode" TEXT NOT NULL,
    "competitorDescription" TEXT,
    "competitorName" TEXT,
    "competitorProductId" TEXT,
    "competitorId" TEXT,
    "crossId" TEXT,
    "crosswalkVersionId" TEXT,
    "equivalenceLevel" TEXT,
    "matchType" TEXT,
    "productId" TEXT,
    "sku" TEXT,
    "description" TEXT,
    "productFamily" TEXT,
    "quantity" DECIMAL(18,4) NOT NULL,
    "uom" TEXT NOT NULL DEFAULT 'EA',
    "listPrice" DECIMAL(18,4),
    "contractPrice" DECIMAL(18,4),
    "contractPriceSource" TEXT,
    "waterfallJson" TEXT,
    "competitorPrice" DECIMAL(18,4),
    "competitorPriceConfidence" DOUBLE PRECISION,
    "competitorPriceBasis" TEXT,
    "competitorIntelJson" TEXT,
    "cost" DECIMAL(18,4),
    "costBasisJson" TEXT,
    "floorPrice" DECIMAL(18,4),
    "targetPrice" DECIMAL(18,4),
    "ceilingPrice" DECIMAL(18,4),
    "recommendedPrice" DECIMAL(18,4),
    "recommendationJson" TEXT,
    "policyId" TEXT,
    "proposedPrice" DECIMAL(18,4),
    "marginAmount" DECIMAL(18,4),
    "marginPct" DECIMAL(9,6),
    "discountFromListPct" DECIMAL(9,6),
    "discountFromContractPct" DECIMAL(9,6),
    "requiredAuthority" TEXT,
    "approvalState" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    "justification" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProposalLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scenario" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'CUSTOM',
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioLine" (
    "scenarioId" TEXT NOT NULL,
    "proposalLineId" TEXT NOT NULL,
    "proposedPrice" DECIMAL(18,4),
    "included" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ScenarioLine_pkey" PRIMARY KEY ("scenarioId","proposalLineId")
);

-- CreateTable
CREATE TABLE "ApprovalRequest" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "proposalLineId" TEXT,
    "requiredRole" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "notes" TEXT,
    "requestedByUserId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionComments" TEXT,
    "snapshotJson" TEXT,
    "policyId" TEXT,

    CONSTRAINT "ApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrosswalkVersion" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "notes" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" TEXT,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "CrosswalkVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrosswalkVersionEntry" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "knownCrossId" TEXT NOT NULL,
    "ownSku" TEXT NOT NULL,
    "competitorName" TEXT NOT NULL,
    "competitorCodeNorm" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "equivalenceLevel" TEXT NOT NULL,
    "approvedUsage" TEXT,
    "additionalProducts" TEXT,

    CONSTRAINT "CrosswalkVersionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalRef" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncHash" TEXT,

    CONSTRAINT "ExternalRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncLog" (
    "id" TEXT NOT NULL,
    "system" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "externalId" TEXT,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "payloadHash" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SyncLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseRecord" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "productId" TEXT,
    "sku" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "netPrice" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "contractId" TEXT,
    "proposalId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'import',
    "externalId" TEXT,
    "documentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealOutcome" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "competitorId" TEXT,
    "priceReason" TEXT,
    "commercialReason" TEXT,
    "finalValue" DECIMAL(18,4),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" TEXT,
    "notes" TEXT,

    CONSTRAINT "DealOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MatchDecision" (
    "id" TEXT NOT NULL,
    "requestLineId" TEXT,
    "proposalLineId" TEXT,
    "topRecommendedSku" TEXT,
    "chosenSku" TEXT,
    "acceptedTop" BOOLEAN NOT NULL,
    "overrideReason" TEXT,
    "productFamily" TEXT,
    "competitorName" TEXT,
    "confidence" DOUBLE PRECISION,
    "decidedByUserId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "groundTruth" TEXT NOT NULL DEFAULT 'UNKNOWN',

    CONSTRAINT "MatchDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_accountNumber_key" ON "Account"("accountNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Account_externalCrmId_key" ON "Account"("externalCrmId");

-- CreateIndex
CREATE INDEX "Account_parentAccountId_idx" ON "Account"("parentAccountId");

-- CreateIndex
CREATE INDEX "Account_name_idx" ON "Account"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Gpo_name_key" ON "Gpo"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Gpo_code_key" ON "Gpo"("code");

-- CreateIndex
CREATE INDEX "GpoMembership_accountId_gpoId_idx" ON "GpoMembership"("accountId", "gpoId");

-- CreateIndex
CREATE UNIQUE INDEX "Opportunity_externalCrmId_key" ON "Opportunity"("externalCrmId");

-- CreateIndex
CREATE UNIQUE INDEX "Contract_contractNumber_key" ON "Contract"("contractNumber");

-- CreateIndex
CREATE INDEX "Contract_accountId_status_idx" ON "Contract"("accountId", "status");

-- CreateIndex
CREATE INDEX "Contract_gpoId_status_idx" ON "Contract"("gpoId", "status");

-- CreateIndex
CREATE INDEX "Contract_type_status_idx" ON "Contract"("type", "status");

-- CreateIndex
CREATE INDEX "ContractScope_contractId_idx" ON "ContractScope"("contractId");

-- CreateIndex
CREATE INDEX "ContractCommitment_contractId_idx" ON "ContractCommitment"("contractId");

-- CreateIndex
CREATE INDEX "RebateSchedule_contractId_idx" ON "RebateSchedule"("contractId");

-- CreateIndex
CREATE INDEX "BundleTerm_contractId_idx" ON "BundleTerm"("contractId");

-- CreateIndex
CREATE INDEX "StandardCost_productId_effectiveFrom_idx" ON "StandardCost"("productId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "ExchangeRate_fromCurrency_toCurrency_asOf_source_key" ON "ExchangeRate"("fromCurrency", "toCurrency", "asOf", "source");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_at_idx" ON "AuditEvent"("entityType", "entityId", "at");

-- CreateIndex
CREATE INDEX "AuditEvent_actorUserId_at_idx" ON "AuditEvent"("actorUserId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "Competitor_name_key" ON "Competitor"("name");

-- CreateIndex
CREATE INDEX "CompetitorPriceObservation_competitorSku_observedAt_idx" ON "CompetitorPriceObservation"("competitorSku", "observedAt");

-- CreateIndex
CREATE INDEX "CompetitorPriceObservation_competitorId_competitorSku_idx" ON "CompetitorPriceObservation"("competitorId", "competitorSku");

-- CreateIndex
CREATE INDEX "CompetitorPriceObservation_accountId_idx" ON "CompetitorPriceObservation"("accountId");

-- CreateIndex
CREATE INDEX "PricingPolicy_productFamily_status_idx" ON "PricingPolicy"("productFamily", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PricingPolicy_productFamily_version_key" ON "PricingPolicy"("productFamily", "version");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_reference_key" ON "Proposal"("reference");

-- CreateIndex
CREATE INDEX "Proposal_accountId_status_idx" ON "Proposal"("accountId", "status");

-- CreateIndex
CREATE INDEX "ProposalLine_proposalId_lineNo_idx" ON "ProposalLine"("proposalId", "lineNo");

-- CreateIndex
CREATE INDEX "Scenario_proposalId_idx" ON "Scenario"("proposalId");

-- CreateIndex
CREATE INDEX "ApprovalRequest_proposalId_status_idx" ON "ApprovalRequest"("proposalId", "status");

-- CreateIndex
CREATE INDEX "ApprovalRequest_status_requiredRole_idx" ON "ApprovalRequest"("status", "requiredRole");

-- CreateIndex
CREATE UNIQUE INDEX "CrosswalkVersion_number_key" ON "CrosswalkVersion"("number");

-- CreateIndex
CREATE INDEX "CrosswalkVersionEntry_versionId_competitorCodeNorm_idx" ON "CrosswalkVersionEntry"("versionId", "competitorCodeNorm");

-- CreateIndex
CREATE INDEX "ExternalRef_entityType_entityId_idx" ON "ExternalRef"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalRef_system_entityType_externalId_key" ON "ExternalRef"("system", "entityType", "externalId");

-- CreateIndex
CREATE INDEX "SyncLog_system_at_idx" ON "SyncLog"("system", "at");

-- CreateIndex
CREATE INDEX "PurchaseRecord_accountId_invoiceDate_idx" ON "PurchaseRecord"("accountId", "invoiceDate");

-- CreateIndex
CREATE INDEX "PurchaseRecord_contractId_idx" ON "PurchaseRecord"("contractId");

-- CreateIndex
CREATE UNIQUE INDEX "DealOutcome_proposalId_key" ON "DealOutcome"("proposalId");

-- CreateIndex
CREATE INDEX "MatchDecision_productFamily_at_idx" ON "MatchDecision"("productFamily", "at");

-- CreateIndex
CREATE INDEX "KnownCross_approvalStatus_idx" ON "KnownCross"("approvalStatus");

-- CreateIndex
CREATE INDEX "PriceEntry_productId_effectiveFrom_idx" ON "PriceEntry"("productId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "PriceEntry_contractId_productId_idx" ON "PriceEntry"("contractId", "productId");

-- CreateIndex
CREATE INDEX "PriceEntry_pricebookId_productId_idx" ON "PriceEntry"("pricebookId", "productId");

-- AddForeignKey
ALTER TABLE "PriceEntry" ADD CONSTRAINT "PriceEntry_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceEntry" ADD CONSTRAINT "PriceEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceEntry" ADD CONSTRAINT "PriceEntry_gpoId_fkey" FOREIGN KEY ("gpoId") REFERENCES "Gpo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Request" ADD CONSTRAINT "Request_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRole" ADD CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_parentAccountId_fkey" FOREIGN KEY ("parentAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GpoMembership" ADD CONSTRAINT "GpoMembership_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GpoMembership" ADD CONSTRAINT "GpoMembership_gpoId_fkey" FOREIGN KEY ("gpoId") REFERENCES "Gpo"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_parentAccountId_fkey" FOREIGN KEY ("parentAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_gpoId_fkey" FOREIGN KEY ("gpoId") REFERENCES "Gpo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractScope" ADD CONSTRAINT "ContractScope_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractCommitment" ADD CONSTRAINT "ContractCommitment_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RebateSchedule" ADD CONSTRAINT "RebateSchedule_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleTerm" ADD CONSTRAINT "BundleTerm_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StandardCost" ADD CONSTRAINT "StandardCost_productId_fkey" FOREIGN KEY ("productId") REFERENCES "OwnProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorPriceObservation" ADD CONSTRAINT "CompetitorPriceObservation_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorPriceObservation" ADD CONSTRAINT "CompetitorPriceObservation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorPriceObservation" ADD CONSTRAINT "CompetitorPriceObservation_gpoId_fkey" FOREIGN KEY ("gpoId") REFERENCES "Gpo"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorPriceObservation" ADD CONSTRAINT "CompetitorPriceObservation_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Request"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_crosswalkVersionId_fkey" FOREIGN KEY ("crosswalkVersionId") REFERENCES "CrosswalkVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalLine" ADD CONSTRAINT "ProposalLine_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProposalLine" ADD CONSTRAINT "ProposalLine_productId_fkey" FOREIGN KEY ("productId") REFERENCES "OwnProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scenario" ADD CONSTRAINT "Scenario_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioLine" ADD CONSTRAINT "ScenarioLine_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioLine" ADD CONSTRAINT "ScenarioLine_proposalLineId_fkey" FOREIGN KEY ("proposalLineId") REFERENCES "ProposalLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalRequest" ADD CONSTRAINT "ApprovalRequest_proposalLineId_fkey" FOREIGN KEY ("proposalLineId") REFERENCES "ProposalLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrosswalkVersionEntry" ADD CONSTRAINT "CrosswalkVersionEntry_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "CrosswalkVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRecord" ADD CONSTRAINT "PurchaseRecord_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRecord" ADD CONSTRAINT "PurchaseRecord_productId_fkey" FOREIGN KEY ("productId") REFERENCES "OwnProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRecord" ADD CONSTRAINT "PurchaseRecord_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRecord" ADD CONSTRAINT "PurchaseRecord_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseRecord" ADD CONSTRAINT "PurchaseRecord_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealOutcome" ADD CONSTRAINT "DealOutcome_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "Proposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealOutcome" ADD CONSTRAINT "DealOutcome_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MatchDecision" ADD CONSTRAINT "MatchDecision_proposalLineId_fkey" FOREIGN KEY ("proposalLineId") REFERENCES "ProposalLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;

