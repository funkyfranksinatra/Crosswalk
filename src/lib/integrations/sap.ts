/**
 * SAP ERP adapter — SKELETON (OData / BAPI via an integration layer). Every method
 * throws NotConfigured until credentials and the interface contract exist.
 *
 * Required: SAP_ODATA_BASE_URL, SAP_CLIENT, SAP_USER/SAP_PASSWORD or OAuth (SAP_TOKEN_URL,
 * SAP_CLIENT_ID, SAP_CLIENT_SECRET); services for material master (MARA/MAKT), sales
 * prices (KONP/A-tables or SD condition API), standard cost by plant (MBEW), and billing
 * documents (VBRK/VBRP) for purchase history.
 */
import { NotConfigured, type ErpAdapter, type ErpSku, type ErpCost, type ErpPurchase } from "./types";

const NEEDS = ["SAP_ODATA_BASE_URL", "SAP_CLIENT", "SAP credentials (basic or OAuth)", "exposed services: material master, condition prices, standard cost by plant, billing documents"];

export class SapErpAdapter implements ErpAdapter {
  readonly system = "sap";
  static configured(): boolean { return Boolean(process.env.SAP_ODATA_BASE_URL); }
  async pullSkuMaster(): Promise<ErpSku[]> { throw new NotConfigured("SAP", NEEDS); }
  async pullStandardCosts(): Promise<ErpCost[]> { throw new NotConfigured("SAP", NEEDS); }
  async pullPurchases(): Promise<ErpPurchase[]> { throw new NotConfigured("SAP", NEEDS); }
}
