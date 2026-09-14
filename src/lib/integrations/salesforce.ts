/**
 * Salesforce CRM adapter — SKELETON. Documents the contract and the credentials it
 * needs; every method throws NotConfigured until they are supplied. Intentionally
 * not a mock: nothing here pretends to have synced.
 *
 * Required env: SF_LOGIN_URL, SF_CLIENT_ID, SF_CLIENT_SECRET (or JWT bearer: SF_JWT_KEY, SF_USERNAME),
 * SF_API_VERSION. Objects: Account (+ParentId), Opportunity, Contact, User, and a custom
 * Crosswalk_Quote__c / Crosswalk_Quote_Line__c (or the CPQ Quote objects, to be decided
 * with the Salesforce admin). GPO affiliation is usually a custom field (Account.GPO__c).
 */
import { NotConfigured, type CrmAdapter, type CrmAccount, type CrmOpportunity, type CrmQuotePush } from "./types";

const NEEDS = ["SF_LOGIN_URL", "SF_CLIENT_ID", "SF_CLIENT_SECRET or SF_JWT_KEY+SF_USERNAME", "SF_API_VERSION", "custom quote objects agreed with the SF admin"];

export class SalesforceCrmAdapter implements CrmAdapter {
  readonly system = "salesforce";
  static configured(): boolean { return Boolean(process.env.SF_LOGIN_URL && process.env.SF_CLIENT_ID); }
  async pullAccounts(): Promise<CrmAccount[]> { throw new NotConfigured("Salesforce", NEEDS); }
  async pullOpportunities(): Promise<CrmOpportunity[]> { throw new NotConfigured("Salesforce", NEEDS); }
  async pushQuote(_q: CrmQuotePush): Promise<{ externalId: string }> { throw new NotConfigured("Salesforce", NEEDS); }
}
