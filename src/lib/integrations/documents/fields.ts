/**
 * The canonical fields an extraction can produce, per document type. Providers map their
 * own output onto these names; the review queue and the downstream importers only know these.
 */
export const DOCUMENT_TYPES = ["INVOICE", "PO", "BID_LIST", "CONTRACT_TABLE", "COMPETITOR_LIST", "OTHER"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const HEADER_FIELDS = ["accountName", "accountNumber", "vendorName", "documentNumber", "documentDate", "currency", "gpoName", "contractNumber"] as const;
export const LINE_FIELDS = ["competitorSku", "description", "manufacturer", "quantity", "uom", "unitPrice", "extendedPrice", "lineDate", "tier"] as const;
export type CanonicalFieldName = (typeof HEADER_FIELDS)[number] | (typeof LINE_FIELDS)[number];

/** Which line fields matter most for review: a line missing one of these is always reviewed. */
export const REQUIRED_LINE_FIELDS: Record<DocumentType, CanonicalFieldName[]> = {
  INVOICE: ["competitorSku", "quantity", "unitPrice"],
  PO: ["competitorSku", "quantity"],
  BID_LIST: ["competitorSku", "quantity"],
  CONTRACT_TABLE: ["competitorSku", "unitPrice"],
  COMPETITOR_LIST: ["competitorSku"],
  OTHER: [],
};
