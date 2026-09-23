-- Tier 2: CRM contacts kept on the account (bounded JSON list)
ALTER TABLE "Account" ADD COLUMN "contactsJson" TEXT;
