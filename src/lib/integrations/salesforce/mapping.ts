/**
 * Canonical entities the CRM integration produces, and the default Salesforce field maps a
 * standard org satisfies. Every company overrides what differs (a custom GPO field, a
 * territory on the owner, a strategic flag) in Settings → Integrations → Salesforce →
 * Mapping; the defaults are a starting point, never an assumption.
 */
import type { FieldMap, MappingSpec } from "../core/mapping";
import { ACCOUNT_TYPES } from "@/lib/accounts/types";

export const ACCOUNT_SPEC: MappingSpec = {
  entity: "Account",
  fields: [
    { name: "externalId", type: "string", required: true, description: "Salesforce Account Id" },
    { name: "name", type: "string", required: true, description: "Account name" },
    { name: "accountNumber", type: "string", description: "The number the ERP and GPO rosters use for this account" },
    { name: "parentExternalId", type: "string", description: "Parent account (IDN / health system) Id" },
    { name: "type", type: "enum", values: ACCOUNT_TYPES, description: "Account type", example: "SOLD_TO" },
    { name: "territory", type: "string", description: "Sales territory — drives rep scoping" },
    { name: "segment", type: "string", description: "Segment / customer class" },
    { name: "region", type: "string", description: "Region for pricing context" },
    { name: "country", type: "string", description: "ISO country", example: "US" },
    { name: "currency", type: "string", description: "Account currency", example: "USD" },
    { name: "isStrategic", type: "boolean", description: "Strategic account flag" },
    { name: "ownerEmail", type: "string", description: "Owning rep's email (matched to a Crosswalk user)" },
    { name: "gpoName", type: "string", description: "GPO affiliation (name)" },
    { name: "gpoTier", type: "string", description: "GPO tier" },
    { name: "sourceUpdatedAt", type: "datetime", description: "Last modified timestamp (incremental sync)" },
  ],
};

export const OPPORTUNITY_SPEC: MappingSpec = {
  entity: "Opportunity",
  fields: [
    { name: "externalId", type: "string", required: true, description: "Opportunity Id" },
    { name: "accountExternalId", type: "string", required: true, description: "Account Id" },
    { name: "name", type: "string", required: true, description: "Opportunity name" },
    { name: "stage", type: "string", required: true, description: "Stage name" },
    { name: "ownerEmail", type: "string", description: "Owner email" },
    { name: "closeDate", type: "date", description: "Close date" },
    { name: "amount", type: "money", description: "Amount" },
    { name: "currency", type: "string", description: "Currency ISO code" },
    { name: "sourceUpdatedAt", type: "datetime", description: "Last modified timestamp" },
  ],
};

export const CONTACT_SPEC: MappingSpec = {
  entity: "Contact",
  fields: [
    { name: "externalId", type: "string", required: true, description: "Contact Id" },
    { name: "accountExternalId", type: "string", required: true, description: "Account Id" },
    { name: "name", type: "string", required: true, description: "Full name" },
    { name: "email", type: "string", description: "Email" },
    { name: "phone", type: "string", description: "Phone" },
    { name: "title", type: "string", description: "Title" },
  ],
};

/** Quote objects are the company's: a custom object pair or CPQ. The map says which fields receive what. */
export const QUOTE_SPEC: MappingSpec = {
  entity: "Quote",
  fields: [
    { name: "externalIdField", type: "string", required: true, description: "External-id field on the quote object that stores the Crosswalk proposal id (makes write-back idempotent)", example: "Crosswalk_Proposal_Id__c" },
    { name: "name", type: "string", required: true, description: "Quote name field", example: "Name" },
    { name: "accountField", type: "string", required: true, description: "Lookup to Account", example: "Account__c" },
    { name: "opportunityField", type: "string", description: "Lookup to Opportunity", example: "Opportunity__c" },
    { name: "statusField", type: "string", description: "Proposal status field", example: "Status__c" },
    { name: "approvalStatusField", type: "string", description: "Approval status field", example: "Approval_Status__c" },
    { name: "totalField", type: "string", description: "Contract value / total field", example: "Total_Value__c" },
    { name: "currencyField", type: "string", description: "Currency ISO code field (multi-currency orgs)", example: "CurrencyIsoCode" },
    { name: "validThroughField", type: "string", description: "Valid-through date field", example: "Valid_Through__c" },
    { name: "savingsField", type: "string", description: "Customer savings field", example: "Customer_Savings__c" },
    { name: "marginField", type: "string", description: "Blended margin field — only written when CRM_PUSH_MARGIN=true", example: "Margin_Pct__c" },
    { name: "referenceField", type: "string", description: "Crosswalk reference (PRP-0001)", example: "Crosswalk_Reference__c" },
  ],
};
export const QUOTE_LINE_SPEC: MappingSpec = {
  entity: "QuoteLine",
  fields: [
    { name: "externalIdField", type: "string", required: true, description: "External-id field on the line object (proposal id + line no)", example: "Crosswalk_Line_Id__c" },
    { name: "quoteField", type: "string", required: true, description: "Master-detail / lookup to the quote", example: "Crosswalk_Quote__c" },
    { name: "skuField", type: "string", required: true, description: "Our SKU", example: "SKU__c" },
    { name: "descriptionField", type: "string", description: "Description", example: "Description__c" },
    { name: "competitorCodeField", type: "string", description: "Competitor code being replaced", example: "Competitor_Code__c" },
    { name: "quantityField", type: "string", description: "Quantity", example: "Quantity__c" },
    { name: "unitPriceField", type: "string", description: "Unit price", example: "Unit_Price__c" },
    { name: "matchTypeField", type: "string", description: "Match type", example: "Match_Type__c" },
    { name: "equivalenceField", type: "string", description: "Equivalence level", example: "Equivalence__c" },
    { name: "approvalStateField", type: "string", description: "Line approval state", example: "Approval_State__c" },
    { name: "lineNoField", type: "string", description: "Line number", example: "Line_No__c" },
  ],
};

export const SALESFORCE_SPECS: Record<string, MappingSpec> = { Account: ACCOUNT_SPEC, Opportunity: OPPORTUNITY_SPEC, Contact: CONTACT_SPEC, Quote: QUOTE_SPEC, QuoteLine: QUOTE_LINE_SPEC };

/** What a plain Salesforce org gives without customisation. `gpoName` has NO default on purpose — it is always the company's field. */
export const SALESFORCE_DEFAULT_MAPPING: Record<string, FieldMap> = {
  Account: {
    externalId: { source: "Id" },
    name: { source: "Name" },
    accountNumber: { source: "AccountNumber" },
    parentExternalId: { source: "ParentId" },
    type: { source: "Type", valueMap: { Customer: "SOLD_TO", Hospital: "SOLD_TO", "Health System": "HEALTH_SYSTEM", IDN: "IDN", "Ship To": "SHIP_TO", "Bill To": "BILL_TO", GPO: "GROUP" }, default: "SOLD_TO", unmapped: "null" },
    territory: { source: "Owner.Territory__c" },
    segment: { source: "Industry" },
    region: { source: "BillingState" },
    country: { source: "BillingCountryCode", default: "US" },
    currency: { source: "CurrencyIsoCode", default: "USD" },
    ownerEmail: { source: "Owner.Email" },
    sourceUpdatedAt: { source: "LastModifiedDate", transform: "datetime" },
  },
  Opportunity: {
    externalId: { source: "Id" },
    accountExternalId: { source: "AccountId" },
    name: { source: "Name" },
    stage: { source: "StageName" },
    ownerEmail: { source: "Owner.Email" },
    closeDate: { source: "CloseDate", transform: "date" },
    amount: { source: "Amount" },
    currency: { source: "CurrencyIsoCode", default: "USD" },
    sourceUpdatedAt: { source: "LastModifiedDate", transform: "datetime" },
  },
  Contact: {
    externalId: { source: "Id" }, accountExternalId: { source: "AccountId" }, name: { source: "Name" }, email: { source: "Email" }, phone: { source: "Phone" }, title: { source: "Title" },
  },
  Quote: { externalIdField: { constant: "Crosswalk_Proposal_Id__c" }, name: { constant: "Name" }, accountField: { constant: "Account__c" }, opportunityField: { constant: "Opportunity__c" }, statusField: { constant: "Status__c" }, approvalStatusField: { constant: "Approval_Status__c" }, totalField: { constant: "Total_Value__c" }, validThroughField: { constant: "Valid_Through__c" }, referenceField: { constant: "Crosswalk_Reference__c" } },
  QuoteLine: { externalIdField: { constant: "Crosswalk_Line_Id__c" }, quoteField: { constant: "Crosswalk_Quote__c" }, skuField: { constant: "SKU__c" }, descriptionField: { constant: "Description__c" }, competitorCodeField: { constant: "Competitor_Code__c" }, quantityField: { constant: "Quantity__c" }, unitPriceField: { constant: "Unit_Price__c" }, matchTypeField: { constant: "Match_Type__c" }, equivalenceField: { constant: "Equivalence__c" }, approvalStateField: { constant: "Approval_State__c" }, lineNoField: { constant: "Line_No__c" } },
};

/** The SOQL SELECT list a field map needs (its source paths), de-duplicated, plus what incremental sync needs. */
export function soqlFields(map: FieldMap, always: string[] = ["Id", "LastModifiedDate"]): string[] {
  const out = new Set(always);
  for (const rule of Object.values(map)) if (rule.source) out.add(rule.source);
  return [...out];
}
