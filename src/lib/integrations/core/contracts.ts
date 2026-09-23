/**
 * The adapter interfaces. Domain code programs against these; providers implement them.
 * Every adapter can test its connection and describe itself; readers return canonical
 * import records (src/lib/integrations/types.ts) with provenance, page by page where the
 * provider paginates, so a sync can checkpoint.
 */
import type { AccountImportRecord, OpportunityImportRecord, ContactImportRecord, GpoAffiliationRecord, QuoteWriteback, QuoteWritebackResult, ProductImportRecord, StandardCostImportRecord, PriceEntryImportRecord, BillingImportRecord, GpoMembershipImportRecord, CompetitorPriceImportRecord, ExtractedDocument, FxRateRecord } from "../types";

export type ConnectionTestResult = { ok: boolean; message: string; details?: Record<string, unknown>; providerRef?: string | null };

/** What a paged reader hands back: records plus the cursor to continue from (null when done). */
export type Page<T> = { records: T[]; nextCursor: string | null; /** rows the adapter could not map (recorded as row errors; the rest of the page still applies) */ rejected?: { externalId: string | null; message: string }[] };
export type PullOptions = { since?: Date | null; cursor?: string | null; limit?: number; signal?: AbortSignal };

export interface ConnectionTester {
  readonly provider: string;
  /** Live providers reach the system; file providers check the location; mocks follow their scenario. */
  testConnection(): Promise<ConnectionTestResult>;
}

export interface DescribesFields {
  /** Field names of a provider object, for mapping validation (null when the provider cannot describe). */
  describeFields(entity: string): Promise<string[] | null>;
}

// ---- 2.1 CRM -------------------------------------------------------------------------------
export interface CRMAdapter extends ConnectionTester, Partial<DescribesFields> {
  fetchAccounts(opts?: PullOptions): Promise<Page<AccountImportRecord>>;
  fetchOpportunities(opts?: PullOptions): Promise<Page<OpportunityImportRecord>>;
  fetchContacts?(opts?: PullOptions): Promise<Page<ContactImportRecord>>;
  /** GPO affiliations may come with the account (a field) or separately (a related object). */
  fetchGpoAffiliations?(opts?: PullOptions): Promise<Page<GpoAffiliationRecord>>;
  /** Idempotent by `quote.idempotencyKey` (the proposal id): a retry updates, never duplicates. */
  createOrUpdateQuote(quote: QuoteWriteback): Promise<QuoteWritebackResult>;
}

// ---- 2.2 ERP -------------------------------------------------------------------------------
export interface ERPAdapter extends ConnectionTester, Partial<DescribesFields> {
  fetchMaterials(opts?: PullOptions): Promise<Page<ProductImportRecord>>;
  fetchStandardCosts(opts?: PullOptions): Promise<Page<StandardCostImportRecord>>;
  fetchListPrices(opts?: PullOptions): Promise<Page<PriceEntryImportRecord>>;
  fetchBillingDocuments(opts?: PullOptions): Promise<Page<BillingImportRecord>>;
}

// ---- 2.3 GPO roster ------------------------------------------------------------------------
export interface GpoRosterAdapter extends ConnectionTester {
  readonly gpoName: string;
  fetchMemberships(opts?: PullOptions): Promise<Page<GpoMembershipImportRecord>>;
}

// ---- 2.4 Document extraction ---------------------------------------------------------------
export type ExtractionRequest = { documentId: string; documentType: string; filename: string; mimeType: string | null; bytes: Buffer | null; /** the manual provider takes a grid instead of bytes */ grid?: (string | number | null)[][] | null };
export interface DocumentExtractionProvider extends ConnectionTester {
  extract(req: ExtractionRequest): Promise<ExtractedDocument>;
}

// ---- 2.5 FX ---------------------------------------------------------------------------------
export interface FxRateProvider extends ConnectionTester {
  /** The rate for the exact date, or null when the provider has none for that date (never a substitute). */
  getRate(baseCurrency: string, quoteCurrency: string, date: string): Promise<FxRateRecord | null>;
  /** Bulk fetch for a schedule (optional). */
  fetchRates?(bases: string[], quotes: string[], date: string): Promise<FxRateRecord[]>;
}

// ---- 2.6 Competitor GPO contract prices ------------------------------------------------------
export interface CompetitorContractPriceAdapter extends ConnectionTester {
  fetchContractPrices(opts?: PullOptions): Promise<Page<CompetitorPriceImportRecord>>;
}
