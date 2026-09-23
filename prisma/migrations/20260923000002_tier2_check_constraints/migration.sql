-- Tier 2: CHECK constraints on the integration layer's state columns.
-- Generated from src/lib/db/constraints.ts by scripts/gen-constraints.ts — edit that file, not this one.

ALTER TABLE "IntegrationConfig" DROP CONSTRAINT IF EXISTS "chk_IntegrationConfig_status";
ALTER TABLE "IntegrationConfig" ADD CONSTRAINT "chk_IntegrationConfig_status" CHECK ("status" IN ('NOT_CONFIGURED', 'CONFIGURED', 'CONNECTED', 'DEGRADED', 'ERROR', 'DISABLED')) NOT VALID;
ALTER TABLE "IntegrationConfig" VALIDATE CONSTRAINT "chk_IntegrationConfig_status";
ALTER TABLE "IntegrationSyncJob" DROP CONSTRAINT IF EXISTS "chk_IntegrationSyncJob_status";
ALTER TABLE "IntegrationSyncJob" ADD CONSTRAINT "chk_IntegrationSyncJob_status" CHECK ("status" IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED')) NOT VALID;
ALTER TABLE "IntegrationSyncJob" VALIDATE CONSTRAINT "chk_IntegrationSyncJob_status";
ALTER TABLE "IntegrationSyncJob" DROP CONSTRAINT IF EXISTS "chk_IntegrationSyncJob_trigger";
ALTER TABLE "IntegrationSyncJob" ADD CONSTRAINT "chk_IntegrationSyncJob_trigger" CHECK ("trigger" IN ('schedule', 'manual', 'webhook', 'startup')) NOT VALID;
ALTER TABLE "IntegrationSyncJob" VALIDATE CONSTRAINT "chk_IntegrationSyncJob_trigger";
ALTER TABLE "IntegrationReviewItem" DROP CONSTRAINT IF EXISTS "chk_IntegrationReviewItem_kind";
ALTER TABLE "IntegrationReviewItem" ADD CONSTRAINT "chk_IntegrationReviewItem_kind" CHECK ("kind" IN ('UNMATCHED_ACCOUNT', 'MEMBERSHIP_CONFLICT', 'DUPLICATE', 'LOW_CONFIDENCE_EXTRACTION', 'PRICE_EXCEPTION', 'UNKNOWN_COMPETITOR', 'MAPPING_ERROR', 'OVERLAP')) NOT VALID;
ALTER TABLE "IntegrationReviewItem" VALIDATE CONSTRAINT "chk_IntegrationReviewItem_kind";
ALTER TABLE "IntegrationReviewItem" DROP CONSTRAINT IF EXISTS "chk_IntegrationReviewItem_status";
ALTER TABLE "IntegrationReviewItem" ADD CONSTRAINT "chk_IntegrationReviewItem_status" CHECK ("status" IN ('OPEN', 'RESOLVED', 'DISMISSED')) NOT VALID;
ALTER TABLE "IntegrationReviewItem" VALIDATE CONSTRAINT "chk_IntegrationReviewItem_status";
ALTER TABLE "DocumentExtraction" DROP CONSTRAINT IF EXISTS "chk_DocumentExtraction_status";
ALTER TABLE "DocumentExtraction" ADD CONSTRAINT "chk_DocumentExtraction_status" CHECK ("status" IN ('PENDING', 'EXTRACTED', 'REVIEW', 'VERIFIED', 'REJECTED', 'FAILED')) NOT VALID;
ALTER TABLE "DocumentExtraction" VALIDATE CONSTRAINT "chk_DocumentExtraction_status";
ALTER TABLE "ExtractedField" DROP CONSTRAINT IF EXISTS "chk_ExtractedField_scope";
ALTER TABLE "ExtractedField" ADD CONSTRAINT "chk_ExtractedField_scope" CHECK ("scope" IN ('HEADER', 'LINE')) NOT VALID;
ALTER TABLE "ExtractedField" VALIDATE CONSTRAINT "chk_ExtractedField_scope";
ALTER TABLE "ExtractedField" DROP CONSTRAINT IF EXISTS "chk_ExtractedField_verificationStatus";
ALTER TABLE "ExtractedField" ADD CONSTRAINT "chk_ExtractedField_verificationStatus" CHECK ("verificationStatus" IN ('UNVERIFIED', 'VERIFIED', 'CORRECTED', 'REJECTED')) NOT VALID;
ALTER TABLE "ExtractedField" VALIDATE CONSTRAINT "chk_ExtractedField_verificationStatus";
ALTER TABLE "IntegrationInboundEvent" DROP CONSTRAINT IF EXISTS "chk_IntegrationInboundEvent_status";
ALTER TABLE "IntegrationInboundEvent" ADD CONSTRAINT "chk_IntegrationInboundEvent_status" CHECK ("status" IN ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED')) NOT VALID;
ALTER TABLE "IntegrationInboundEvent" VALIDATE CONSTRAINT "chk_IntegrationInboundEvent_status";
