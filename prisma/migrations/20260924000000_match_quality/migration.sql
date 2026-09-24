-- Match quality model (docs/MATCH_QUALITY_MODEL.md): intake descriptions as evidence, confidence and
-- price provenance on candidates, successor SKUs for discontinued catalog rows.
ALTER TABLE "RequestLine" ADD COLUMN "description" TEXT;
ALTER TABLE "MatchCandidate" ADD COLUMN "confidence" DOUBLE PRECISION;
ALTER TABLE "MatchCandidate" ADD COLUMN "priceSource" TEXT;
ALTER TABLE "OwnProduct" ADD COLUMN "successorSku" TEXT;
