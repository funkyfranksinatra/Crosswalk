-- Tier 0.8: an ADMIN approving their own request is recorded as a break-glass decision.
ALTER TABLE "ApprovalRequest" ADD COLUMN "breakGlass" BOOLEAN NOT NULL DEFAULT false;
