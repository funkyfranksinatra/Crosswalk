-- Tier 3.1: a rep's "verify" flag on a cross-reference line (set singly or by a bulk action).
ALTER TABLE "RequestLine" ADD COLUMN "flag" TEXT;
