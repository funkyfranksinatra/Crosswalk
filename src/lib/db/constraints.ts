/**
 * Database CHECK constraints (Tier 0.6) — the single definition the migration is generated
 * from, the preflight checks against, and the unit test pins to the application's own enum
 * lists. State and type columns are enforced in the database so a direct SQL write, an
 * import, or a future code path cannot seed a value the application does not understand;
 * quantities and prices cannot go negative; date ranges cannot end before they start.
 *
 * Provenance tags (`source`, `sourceSystem`, `system`, `taxProvider`) are deliberately not
 * constrained: they name where a row came from and grow with every integration.
 *
 *   npm run db:preflight        rows that would violate the constraints (run before migrating)
 *   npx tsx scripts/gen-constraints.ts   regenerate the migration SQL from this file
 */
import { ROLES } from "@/lib/auth/permissions";
import { KINDS } from "@/lib/notifications/kinds";
import { EQUIVALENCE } from "@/lib/xref/equivalence";
import { SOURCE_TYPES } from "@/lib/intelligence/summarize";
import { ACCOUNT_TYPES } from "@/lib/accounts/types";
import { HEALTH_STATES } from "@/lib/integrations/core/health";
import { REVIEW_KINDS } from "@/lib/integrations/core/review";

export type EnumConstraint = { table: string; column: string; values: readonly string[]; /** 2 = integration layer, 3 = curated evidence conflicts (each its own migration); absent = Tier 0 */ tier?: 2 | 3 };
export type ExprConstraint = { table: string; name: string; expr: string; description: string; tier?: 2 | 3 };

export const ENUM_CONSTRAINTS: EnumConstraint[] = [
  { table: "UserRole", column: "role", values: ROLES },
  { table: "Notification", column: "kind", values: KINDS },
  { table: "NotificationPreference", column: "kind", values: [...KINDS, "*"] },
  { table: "KnownCross", column: "approvalStatus", values: ["DRAFT", "IN_REVIEW", "APPROVED", "REJECTED", "RETIRED"] },
  { table: "KnownCross", column: "conflictStatus", values: ["CONTRADICTED", "KEPT"], tier: 3 },
  { table: "KnownCross", column: "clinicalReviewStatus", values: ["NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED"] },
  { table: "KnownCross", column: "equivalenceLevel", values: EQUIVALENCE },
  { table: "ProposalLine", column: "equivalenceLevel", values: EQUIVALENCE },
  { table: "PriceEntry", column: "status", values: ["ACTIVE", "PENDING", "EXPIRED", "SUPERSEDED"] },
  { table: "PriceEntry", column: "approvalState", values: ["APPROVED", "PENDING", "REJECTED"] },
  { table: "Request", column: "status", values: ["draft", "queued", "running", "complete", "failed", "cancelled"] },
  { table: "RequestLine", column: "resolutionStatus", values: ["pending", "resolved", "not-found", "error"] },
  { table: "RequestLine", column: "matchStatus", values: ["pending", "matched", "no-match", "error"] },
  { table: "Account", column: "type", values: ACCOUNT_TYPES },
  { table: "Contract", column: "type", values: ["LIST", "GPO", "IDN", "LOCAL", "NATIONAL"] },
  { table: "Contract", column: "status", values: ["DRAFT", "ACTIVE", "EXPIRED", "TERMINATED", "SUPERSEDED"] },
  { table: "RebateSchedule", column: "type", values: ["VOLUME", "GROWTH", "COMPLIANCE", "FAMILY", "BUNDLE"] },
  { table: "RebateSchedule", column: "basis", values: ["UNITS", "VALUE", "COMPLIANCE_PCT", "GROWTH_PCT"] },
  { table: "StandardCost", column: "costType", values: ["STANDARD", "LANDED", "TRANSFER"] },
  { table: "Document", column: "kind", values: ["INVOICE", "PO", "BID_FILE", "CONTRACT", "COMPETITOR_LIST", "OTHER"] },
  { table: "CompetitorPriceObservation", column: "sourceType", values: SOURCE_TYPES },
  { table: "CompetitorPriceObservation", column: "verificationStatus", values: ["UNVERIFIED", "VERIFIED", "DISPUTED"] },
  { table: "PricingPolicy", column: "status", values: ["DRAFT", "ACTIVE", "SUPERSEDED"] },
  { table: "PricingPolicy", column: "floorMethod", values: ["COST_PLUS_MIN_MARGIN", "PCT_OF_LIST", "FIXED"] },
  { table: "PricingPolicy", column: "defaultStrategy", values: ["MATCH", "UNDERCUT_AMOUNT", "UNDERCUT_PCT", "HOLD_PREMIUM", "PRESERVE_CONTRACT", "STRATEGIC_DISCOUNT", "PENETRATION"] },
  { table: "PricingPolicy", column: "classification", values: ["COMMODITY", "DIFFERENTIATED"] },
  { table: "Proposal", column: "status", values: ["DRAFT", "APPROVAL_REQUIRED", "SUBMITTED", "PARTIALLY_APPROVED", "APPROVED", "REJECTED", "CHANGES_REQUESTED", "EXPIRED", "WON", "LOST"] },
  { table: "Proposal", column: "freightMode", values: ["NONE", "FLAT", "PCT"] },
  { table: "Proposal", column: "taxMode", values: ["NONE", "EXEMPT", "MANUAL", "PROVIDER"] },
  { table: "ProposalLine", column: "contractPriceSource", values: ["LIST", "GPO", "IDN", "LOCAL", "NATIONAL"] },
  { table: "ProposalLine", column: "competitorPriceBasis", values: ["KNOWN_ACCOUNT", "MARKET_ESTIMATE", "WEAK", "NONE"] },
  { table: "ProposalLine", column: "approvalState", values: ["NOT_REQUIRED", "REQUIRED", "PENDING", "APPROVED", "REJECTED"] },
  { table: "Scenario", column: "kind", values: ["RECOMMENDED", "AGGRESSIVE", "MARGIN_OPTIMIZED", "CUSTOMER_REQUESTED", "CUSTOM", "FINAL"] },
  { table: "ApprovalRequest", column: "status", values: ["PENDING", "APPROVED", "REJECTED", "CHANGES_REQUESTED", "WITHDRAWN", "EXPIRED"] },
  { table: "CrosswalkVersion", column: "status", values: ["DRAFT", "IN_REVIEW", "PUBLISHED", "SUPERSEDED", "RETIRED"] },
  { table: "SyncLog", column: "direction", values: ["IN", "OUT"] },
  { table: "SyncLog", column: "status", values: ["OK", "RETRY", "FAILED", "SKIPPED"] },
  { table: "DealOutcome", column: "outcome", values: ["WON", "LOST", "NO_DECISION"] },
  { table: "MatchDecision", column: "groundTruth", values: ["VALIDATED_CORRECT", "VALIDATED_INCORRECT", "UNKNOWN"] },
  { table: "GudidImport", column: "status", values: ["QUEUED", "RUNNING", "DONE", "FAILED", "CANCELLED"] },
  { table: "Alert", column: "severity", values: ["INFO", "WARNING", "CRITICAL"] },
  { table: "FeedRun", column: "trigger", values: ["schedule", "manual", "startup"] },
  { table: "FeedRun", column: "status", values: ["RUNNING", "OK", "FAILED", "SKIPPED"] },
  { table: "AnalyticsSnapshot", column: "trigger", values: ["schedule", "event", "manual"] },
  { table: "PublicAward", column: "source", values: ["SAM", "USASPENDING", "BIDFILE"] },
  // Tier 2 (integration layer) — these live in their own migration (20260923000002) so the Tier 0 file stays byte-identical to its generator output.
  { table: "IntegrationConfig", column: "status", values: HEALTH_STATES, tier: 2 },
  { table: "IntegrationSyncJob", column: "status", values: ["QUEUED", "RUNNING", "SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"], tier: 2 },
  { table: "IntegrationSyncJob", column: "trigger", values: ["schedule", "manual", "webhook", "startup"], tier: 2 },
  { table: "IntegrationReviewItem", column: "kind", values: REVIEW_KINDS, tier: 2 },
  { table: "IntegrationReviewItem", column: "status", values: ["OPEN", "RESOLVED", "DISMISSED"], tier: 2 },
  { table: "DocumentExtraction", column: "status", values: ["PENDING", "EXTRACTED", "REVIEW", "VERIFIED", "REJECTED", "FAILED"], tier: 2 },
  { table: "ExtractedField", column: "scope", values: ["HEADER", "LINE"], tier: 2 },
  { table: "ExtractedField", column: "verificationStatus", values: ["UNVERIFIED", "VERIFIED", "CORRECTED", "REJECTED"], tier: 2 },
  { table: "IntegrationInboundEvent", column: "status", values: ["RECEIVED", "PROCESSED", "IGNORED", "FAILED"], tier: 2 },
];

export const EXPR_CONSTRAINTS: ExprConstraint[] = [
  { table: "RequestLine", name: "quantity_nonneg", expr: '"quantity" >= 0', description: "requested quantity cannot be negative" },
  { table: "ProposalLine", name: "quantity_nonneg", expr: '"quantity" >= 0', description: "proposal quantity cannot be negative" },
  { table: "ProposalLine", name: "prices_nonneg", expr: '("proposedPrice" IS NULL OR "proposedPrice" >= 0) AND ("listPrice" IS NULL OR "listPrice" >= 0) AND ("floorPrice" IS NULL OR "floorPrice" >= 0) AND ("recommendedPrice" IS NULL OR "recommendedPrice" >= 0)', description: "proposal prices cannot be negative" },
  { table: "PriceEntry", name: "price_nonneg", expr: '"price" >= 0', description: "price entries cannot be negative" },
  { table: "PriceEntry", name: "qty_band", expr: '"minQty" IS NULL OR "maxQty" IS NULL OR "maxQty" >= "minQty"', description: "a quantity band ends at or after it starts" },
  { table: "PurchaseRecord", name: "netprice_nonneg", expr: '"netPrice" >= 0', description: "purchase net price cannot be negative" },
  { table: "CompetitorPriceObservation", name: "price_nonneg", expr: '"price" >= 0', description: "observed price cannot be negative" },
  { table: "StandardCost", name: "cost_nonneg", expr: '"cost" >= 0', description: "standard cost cannot be negative" },
  { table: "PricingPolicy", name: "margin_fraction", expr: '"targetMarginPct" >= 0 AND "targetMarginPct" <= 1 AND "minMarginPct" >= 0 AND "minMarginPct" <= 1', description: "policy margins are fractions (0.45 = 45%)" },
  { table: "Proposal", name: "freight_value", expr: '"freightValue" IS NULL OR ("freightValue" >= 0 AND ("freightMode" <> \'PCT\' OR "freightValue" <= 100))', description: "freight is a non-negative amount, or 0..100 percent" },
  { table: "Proposal", name: "tax_amount_nonneg", expr: '"taxAmount" IS NULL OR "taxAmount" >= 0', description: "tax cannot be negative" },
  { table: "Contract", name: "term_order", expr: '"effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"', description: "a contract ends at or after it starts" },
  { table: "GpoMembership", name: "term_order", expr: '"effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"', description: "a membership ends at or after it starts" },
  { table: "PriceEntry", name: "term_order", expr: '"effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom"', description: "a price ends at or after it starts" },
  { table: "ApprovalDelegation", name: "window_order", expr: '"endsAt" > "startsAt"', description: "a delegation window ends after it starts" },
];

export function constraintName(c: EnumConstraint | ExprConstraint): string {
  return "column" in c ? `chk_${c.table}_${c.column}` : `chk_${c.table}_${c.name}`;
}
export function constraintExpr(c: EnumConstraint | ExprConstraint): string {
  return "column" in c ? `"${c.column}" IN (${c.values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})` : c.expr;
}

/**
 * The migration SQL: idempotent (drops then adds). Constraints are added NOT VALID and then
 * VALIDATEd: the add takes its exclusive lock for an instant, and the validation scan only
 * takes SHARE UPDATE EXCLUSIVE, so a running instance keeps writing while a long history is
 * checked. Existing rows are still checked — a violating row fails the migration, which is
 * what `npm run db:preflight` exists to catch first.
 */
export function migrationSql(tier: 0 | 2 | 3 = 0): string {
  const lines = [tier === 2 ? "-- Tier 2: CHECK constraints on the integration layer's state columns." : tier === 3 ? "-- Curated evidence conflicts: CHECK constraint on KnownCross.conflictStatus." : "-- Tier 0.6: CHECK constraints on state, type and money columns.", "-- Generated from src/lib/db/constraints.ts by scripts/gen-constraints.ts — edit that file, not this one.", ""];
  for (const c of [...ENUM_CONSTRAINTS, ...EXPR_CONSTRAINTS].filter((c) => (c.tier ?? 0) === tier)) {
    const name = constraintName(c);
    lines.push(`ALTER TABLE "${c.table}" DROP CONSTRAINT IF EXISTS "${name}";`);
    lines.push(`ALTER TABLE "${c.table}" ADD CONSTRAINT "${name}" CHECK (${constraintExpr(c)}) NOT VALID;`);
    lines.push(`ALTER TABLE "${c.table}" VALIDATE CONSTRAINT "${name}";`);
  }
  return lines.join("\n") + "\n";
}

/** Per constraint, the SQL counting rows that would violate it (NULLs pass CHECKs, as in Postgres). */
export function violationQueries(): { name: string; table: string; sql: string; description: string }[] {
  return [...ENUM_CONSTRAINTS, ...EXPR_CONSTRAINTS].map((c) => ({
    name: constraintName(c),
    table: c.table,
    sql: `SELECT count(*)::int AS n FROM "${c.table}" WHERE NOT (${constraintExpr(c)}) AND (${constraintExpr(c)}) IS NOT NULL`,
    description: "column" in c ? `${c.table}.${c.column} must be one of ${c.values.join(", ")}` : c.description,
  }));
}
