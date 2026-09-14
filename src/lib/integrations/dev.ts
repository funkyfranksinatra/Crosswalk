/**
 * DEVELOPMENT adapters — fixture-backed, for demos and tests only.
 * Every record they return is tagged system = "dev". They never talk to a network.
 */
import fs from "node:fs";
import path from "node:path";
import type { CrmAdapter, CrmAccount, CrmOpportunity, CrmQuotePush, ErpAdapter, ErpSku, ErpCost, ErpPurchase, GpoAdapter, GpoMembershipRecord } from "./types";

const FIX = path.resolve(process.cwd(), "data/fixtures/integrations");
function load<T>(name: string): T[] {
  const p = path.join(FIX, name);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as T[]; } catch { return []; }
}

export class DevCrmAdapter implements CrmAdapter {
  readonly system = "dev";
  async pullAccounts(): Promise<CrmAccount[]> { return load<CrmAccount>("crm-accounts.json"); }
  async pullOpportunities(): Promise<CrmOpportunity[]> { return load<CrmOpportunity>("crm-opportunities.json"); }
  async pushQuote(quote: CrmQuotePush): Promise<{ externalId: string }> {
    const out = path.join(FIX, "pushed-quotes");
    fs.mkdirSync(out, { recursive: true });
    const externalId = `DEVQ-${quote.reference}`;
    fs.writeFileSync(path.join(out, `${externalId}.json`), JSON.stringify(quote, null, 2));
    return { externalId };
  }
}

export class DevErpAdapter implements ErpAdapter {
  readonly system = "dev";
  async pullSkuMaster(): Promise<ErpSku[]> { return load<ErpSku>("erp-skus.json"); }
  async pullStandardCosts(): Promise<ErpCost[]> { return load<ErpCost>("erp-costs.json"); }
  async pullPurchases(): Promise<ErpPurchase[]> { return load<ErpPurchase>("erp-purchases.json"); }
}

export class DevGpoAdapter implements GpoAdapter {
  readonly system = "dev";
  async pullMemberships(): Promise<GpoMembershipRecord[]> { return load<GpoMembershipRecord>("gpo-memberships.json"); }
}
