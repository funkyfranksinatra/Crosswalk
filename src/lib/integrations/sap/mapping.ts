/**
 * Canonical ERP entities and the default field maps for the standard S/4HANA Cloud APIs
 * (API_PRODUCT_SRV, API_PRODUCT_VALUATION? no — standard cost is usually a custom CDS view;
 * API_SLSPRICINGCONDITIONRECORD_SRV, API_BILLING_DOCUMENT_SRV). ECC Gateway services and
 * custom Z-services differ, so every path is overridable per company.
 */
import type { FieldMap, MappingSpec } from "../core/mapping";

export const MATERIAL_SPEC: MappingSpec = { entity: "Material", fields: [
  { name: "sku", type: "string", required: true, description: "Material number (our SKU)" },
  { name: "description", type: "string", required: true, description: "Material description" },
  { name: "productFamily", type: "string", description: "Product family / hierarchy / group" },
  { name: "uom", type: "string", description: "Base unit of measure", example: "EA" },
  { name: "status", type: "string", description: "Material status" },
  { name: "discontinued", type: "boolean", description: "Discontinued / deletion flag" },
  { name: "listPrice", type: "money", description: "List price when the material service carries one" },
  { name: "currency", type: "string", description: "Currency", example: "USD" },
  { name: "sourceUpdatedAt", type: "datetime", description: "Last change timestamp" },
] };
export const COST_SPEC: MappingSpec = { entity: "StandardCost", fields: [
  { name: "sku", type: "string", required: true, description: "Material number" },
  { name: "plant", type: "string", description: "Plant" },
  { name: "cost", type: "money", required: true, description: "Standard price per costing unit" },
  { name: "currency", type: "string", description: "Currency", example: "USD" },
  { name: "costType", type: "enum", values: ["STANDARD", "LANDED", "TRANSFER"], description: "Cost type" },
  { name: "effectiveFrom", type: "date", required: true, description: "Valid from (costing period start)" },
  { name: "effectiveTo", type: "date", description: "Valid to" },
  { name: "priceUnit", type: "number", description: "Price unit (cost is per this many)" },
] };
export const PRICE_SPEC: MappingSpec = { entity: "PriceCondition", fields: [
  { name: "sku", type: "string", required: true, description: "Material number" },
  { name: "price", type: "money", required: true, description: "Condition rate" },
  { name: "currency", type: "string", description: "Condition currency", example: "USD" },
  { name: "conditionType", type: "string", description: "Condition type (PR00 list price, ZLST…)" },
  { name: "pricebook", type: "string", description: "Sales org / distribution channel / price list → pricebook name" },
  { name: "effectiveFrom", type: "date", required: true, description: "Valid from" },
  { name: "effectiveTo", type: "date", description: "Valid to" },
  { name: "uom", type: "string", description: "Condition unit" },
  { name: "minQty", type: "number", description: "Scale quantity (from)" },
] };
export const BILLING_SPEC: MappingSpec = { entity: "BillingDocument", fields: [
  { name: "externalId", type: "string", required: true, description: "Billing document + item" },
  { name: "accountNumber", type: "string", description: "Sold-to party (customer number)" },
  { name: "accountExternalId", type: "string", description: "CRM account id when the ERP carries it" },
  { name: "sku", type: "string", required: true, description: "Material number" },
  { name: "quantity", type: "number", required: true, description: "Billed quantity" },
  { name: "netPrice", type: "money", required: true, description: "Net price per unit (or net value ÷ quantity)" },
  { name: "currency", type: "string", description: "Currency", example: "USD" },
  { name: "invoiceDate", type: "date", required: true, description: "Billing date" },
  { name: "contractNumber", type: "string", description: "Contract / agreement reference" },
] };
export const SAP_SPECS: Record<string, MappingSpec> = { Material: MATERIAL_SPEC, StandardCost: COST_SPEC, PriceCondition: PRICE_SPEC, BillingDocument: BILLING_SPEC };

export const SAP_DEFAULT_MAPPING: Record<string, FieldMap> = {
  Material: { sku: { source: "Product" }, description: { source: "ProductDescription" }, productFamily: { source: "ProductGroup" }, uom: { source: "BaseUnit" }, status: { source: "CrossPlantStatus" }, discontinued: { source: "IsMarkedForDeletion", transform: "bool" }, sourceUpdatedAt: { source: "LastChangeDateTime", transform: "datetime" } },
  StandardCost: { sku: { source: "Product" }, plant: { source: "ValuationArea" }, cost: { source: "StandardPrice" }, currency: { source: "Currency", default: "USD" }, priceUnit: { source: "PriceUnitQty" }, effectiveFrom: { source: "ValidityStartDate", transform: "date" }, costType: { constant: "STANDARD" } },
  PriceCondition: { sku: { source: "Material" }, price: { source: "ConditionRateValue" }, currency: { source: "ConditionRateValueUnit", default: "USD" }, conditionType: { source: "ConditionType" }, pricebook: { source: "SalesOrganization" }, effectiveFrom: { source: "ConditionValidityStartDate", transform: "date" }, effectiveTo: { source: "ConditionValidityEndDate", transform: "date" }, uom: { source: "ConditionQuantityUnit" }, minQty: { source: "ConditionQuantity" } },
  BillingDocument: { externalId: { source: "BillingDocument" }, accountNumber: { source: "SoldToParty" }, sku: { source: "Material" }, quantity: { source: "BillingQuantity" }, netPrice: { source: "NetAmount" }, currency: { source: "TransactionCurrency", default: "USD" }, invoiceDate: { source: "BillingDocumentDate", transform: "date" }, contractNumber: { source: "ReferenceSDDocument" } },
};
