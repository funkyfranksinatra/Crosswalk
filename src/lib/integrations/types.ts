/**
 * Integration contracts. The core domain never imports a vendor SDK; it talks to
 * these interfaces. Each system has a real adapter (skeleton until credentials
 * exist — it says exactly what it needs) and a DevAdapter backed by fixtures that
 * is unmistakably labelled as such.
 *
 * Systems of record (docs/INTEGRATIONS.md):
 *   CRM  → Account, parent, Opportunity, contact, rep, territory, GPO affiliation, strategic flag
 *   ERP  → SKU master, description, family, UOM, list price, standard cost (plant/region), status, purchases
 *   GPO  → membership + tier + effective dates
 *   Crosswalk → crosswalk versions, observations, policies, proposals, recommendations, approvals, outcomes
 */

export type CrmAccount = { externalId: string; name: string; accountNumber?: string | null; parentExternalId?: string | null; type?: string; territory?: string | null; segment?: string | null; region?: string | null; country?: string; currency?: string; isStrategic?: boolean; ownerEmail?: string | null; gpoName?: string | null; gpoTier?: string | null };
export type CrmOpportunity = { externalId: string; accountExternalId: string; name: string; stage: string; ownerEmail?: string | null; closeDate?: string | null; amount?: string | null; currency?: string };
export type CrmQuotePush = { proposalId: string; reference: string; accountExternalId: string; opportunityExternalId?: string | null; status: string; currency: string; totalValue: string; customerSavings: string | null; blendedMarginPct: string | null; validThrough: string | null; lines: { sku: string | null; description: string | null; competitorCode: string; quantity: string; unitPrice: string | null; matchType: string | null; equivalenceLevel: string | null; approvalState: string }[]; documents?: { name: string; url: string }[] };

export interface CrmAdapter {
  readonly system: string;
  pullAccounts(since?: Date): Promise<CrmAccount[]>;
  pullOpportunities(since?: Date): Promise<CrmOpportunity[]>;
  pushQuote(quote: CrmQuotePush): Promise<{ externalId: string }>;
}

export type ErpSku = { sku: string; description: string; productFamily?: string | null; uom?: string; listPrice?: string | null; currency?: string; status?: string | null; discontinued?: boolean };
export type ErpCost = { sku: string; plant?: string | null; region?: string | null; currency: string; costType?: string; cost: string; effectiveFrom: string; effectiveTo?: string | null };
export type ErpPurchase = { externalId: string; accountExternalId?: string | null; accountNumber?: string | null; sku: string; quantity: string; netPrice: string; currency: string; invoiceDate: string; contractNumber?: string | null };

export interface ErpAdapter {
  readonly system: string;
  pullSkuMaster(since?: Date): Promise<ErpSku[]>;
  pullStandardCosts(since?: Date): Promise<ErpCost[]>;
  pullPurchases(since?: Date): Promise<ErpPurchase[]>;
}

export type GpoMembershipRecord = { gpoName: string; gpoCode?: string | null; accountExternalId?: string | null; accountNumber?: string | null; tier?: string | null; effectiveFrom: string; effectiveTo?: string | null; source?: string };

export interface GpoAdapter {
  readonly system: string;
  pullMemberships(since?: Date): Promise<GpoMembershipRecord[]>;
}

export class NotConfigured extends Error {
  needs: string[];
  constructor(system: string, needs: string[]) {
    super(`${system} integration is not configured. Required: ${needs.join(", ")}`);
    this.needs = needs;
  }
}
