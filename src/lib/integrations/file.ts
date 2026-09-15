/**
 * FILE FEED adapters — the first real integration path most organisations can use
 * before an API integration is approved: CRM, ERP and the GPO portal all export CSV.
 *
 * Set INTEGRATION_FEED_DIR to a folder (a network share, an SFTP landing zone, a synced
 * OneDrive folder). Drop these files in it, with the column headers below (extra columns
 * are ignored, order does not matter):
 *
 *   crm-accounts.csv       externalId, name, accountNumber, parentExternalId, type, territory, segment,
 *                          region, country, currency, isStrategic, ownerEmail, gpoName, gpoTier
 *   crm-opportunities.csv  externalId, accountExternalId, name, stage, ownerEmail, closeDate, amount, currency
 *   erp-skus.csv           sku, description, productFamily, uom, listPrice, currency, status, discontinued
 *   erp-costs.csv          sku, plant, region, currency, costType, cost, effectiveFrom, effectiveTo
 *   erp-purchases.csv      externalId, accountExternalId, accountNumber, sku, quantity, netPrice, currency,
 *                          invoiceDate, contractNumber
 *   gpo-memberships.csv    gpoName, gpoCode, accountExternalId, accountNumber, tier, effectiveFrom, effectiveTo, source
 *
 * Quotes pushed "to CRM" land in <dir>/outbound/quotes/<reference>.json for the CRM team
 * (or an iPaaS job) to load. Records are tagged system = "file". The sync is the same
 * idempotent, hashed, logged sync the API adapters use, so switching to Salesforce/SAP
 * later changes nothing downstream.
 */
import fs from "node:fs";
import path from "node:path";
import { parseCsv } from "@/lib/sheets/csv";
import type { CrmAdapter, CrmAccount, CrmOpportunity, CrmQuotePush, ErpAdapter, ErpSku, ErpCost, ErpPurchase, GpoAdapter, GpoMembershipRecord } from "./types";

export const FEED_FILES = {
  crm: ["crm-accounts.csv", "crm-opportunities.csv"],
  erp: ["erp-skus.csv", "erp-costs.csv", "erp-purchases.csv"],
  gpo: ["gpo-memberships.csv"],
} as const;

export function feedDir(): string | null {
  const d = process.env.INTEGRATION_FEED_DIR?.trim();
  return d ? path.resolve(d) : null;
}

export function feedFilesPresent(): Record<string, boolean> {
  const dir = feedDir();
  const out: Record<string, boolean> = {};
  for (const files of Object.values(FEED_FILES)) for (const f of files) out[f] = Boolean(dir && fs.existsSync(path.join(dir, f)));
  return out;
}

function readCsv(name: string): Record<string, string>[] {
  const dir = feedDir();
  if (!dir) return [];
  const p = path.join(dir, name);
  if (!fs.existsSync(p)) return [];
  const rows = parseCsv(fs.readFileSync(p, "utf8").replace(/^﻿/, ""));
  if (rows.length < 2) return [];
  const headers = rows[0].map((h) => String(h ?? "").trim());
  return rows.slice(1).filter((r) => r.some((c) => String(c ?? "").trim() !== "")).map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i] ?? "").trim()])));
}

const str = (v: string | undefined) => (v === undefined || v === "" ? null : v);
const bool = (v: string | undefined) => /^(true|yes|y|1|x)$/i.test(v ?? "");

export class FileCrmAdapter implements CrmAdapter {
  readonly system = "file";
  static configured(): boolean { return Boolean(feedDir()); }
  async pullAccounts(): Promise<CrmAccount[]> {
    return readCsv("crm-accounts.csv").filter((r) => r.externalId && r.name).map((r) => ({ externalId: r.externalId, name: r.name, accountNumber: str(r.accountNumber), parentExternalId: str(r.parentExternalId), type: str(r.type) ?? undefined, territory: str(r.territory), segment: str(r.segment), region: str(r.region), country: str(r.country) ?? undefined, currency: str(r.currency) ?? undefined, isStrategic: bool(r.isStrategic), ownerEmail: str(r.ownerEmail), gpoName: str(r.gpoName), gpoTier: str(r.gpoTier) }));
  }
  async pullOpportunities(): Promise<CrmOpportunity[]> {
    return readCsv("crm-opportunities.csv").filter((r) => r.externalId && r.accountExternalId).map((r) => ({ externalId: r.externalId, accountExternalId: r.accountExternalId, name: r.name, stage: r.stage || "Open", ownerEmail: str(r.ownerEmail), closeDate: str(r.closeDate), amount: str(r.amount), currency: str(r.currency) ?? undefined }));
  }
  async pushQuote(quote: CrmQuotePush): Promise<{ externalId: string }> {
    const out = path.join(feedDir()!, "outbound", "quotes");
    fs.mkdirSync(out, { recursive: true });
    const externalId = `FILEQ-${quote.reference}`;
    fs.writeFileSync(path.join(out, `${externalId}.json`), JSON.stringify(quote, null, 2));
    return { externalId };
  }
}

export class FileErpAdapter implements ErpAdapter {
  readonly system = "file";
  static configured(): boolean { return Boolean(feedDir()); }
  async pullSkuMaster(): Promise<ErpSku[]> {
    return readCsv("erp-skus.csv").filter((r) => r.sku).map((r) => ({ sku: r.sku, description: r.description || r.sku, productFamily: str(r.productFamily), uom: str(r.uom) ?? undefined, listPrice: str(r.listPrice), currency: str(r.currency) ?? undefined, status: str(r.status), discontinued: bool(r.discontinued) }));
  }
  async pullStandardCosts(): Promise<ErpCost[]> {
    return readCsv("erp-costs.csv").filter((r) => r.sku && r.cost && r.effectiveFrom).map((r) => ({ sku: r.sku, plant: str(r.plant), region: str(r.region), currency: r.currency || "USD", costType: str(r.costType) ?? undefined, cost: r.cost, effectiveFrom: r.effectiveFrom, effectiveTo: str(r.effectiveTo) }));
  }
  async pullPurchases(): Promise<ErpPurchase[]> {
    return readCsv("erp-purchases.csv").filter((r) => r.externalId && r.sku && r.invoiceDate).map((r) => ({ externalId: r.externalId, accountExternalId: str(r.accountExternalId), accountNumber: str(r.accountNumber), sku: r.sku, quantity: r.quantity || "0", netPrice: r.netPrice || "0", currency: r.currency || "USD", invoiceDate: r.invoiceDate, contractNumber: str(r.contractNumber) }));
  }
}

export class FileGpoAdapter implements GpoAdapter {
  readonly system = "file";
  static configured(): boolean { return Boolean(feedDir()); }
  async pullMemberships(): Promise<GpoMembershipRecord[]> {
    return readCsv("gpo-memberships.csv").filter((r) => r.gpoName && (r.accountExternalId || r.accountNumber) && r.effectiveFrom).map((r) => ({ gpoName: r.gpoName, gpoCode: str(r.gpoCode), accountExternalId: str(r.accountExternalId), accountNumber: str(r.accountNumber), tier: str(r.tier), effectiveFrom: r.effectiveFrom, effectiveTo: str(r.effectiveTo), source: str(r.source) ?? "gpo-feed" }));
  }
}
