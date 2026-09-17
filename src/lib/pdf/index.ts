/**
 * Spec builders for the two customer artefacts: what goes on the page, from the same data the
 * workbooks use (proposal snapshot lines; request offer rows). Rendering is in ./documents.ts.
 */
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { type Actor, requirePermission } from "@/lib/auth";
import { money, round, times, ZERO } from "@/lib/money";
import { finalizeCheck } from "@/lib/approvals/service";
import { getBranding } from "@/lib/branding";
import { quoteTotals } from "@/lib/tax";
import { renderDocument, type DocSpec } from "./documents";

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "").replace(/(\d{8})(\d{4})/, "$1_$2");
const safe = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_");

/** The quotation PDF from an approved proposal — same gate and audit as the workbook. */
export async function buildQuotePdf(actor: Actor, proposalId: string): Promise<{ filename: string; buffer: Buffer; contentType: string }> {
  requirePermission(actor, "export_proposals");
  const f = await finalizeCheck(proposalId);
  if (!f.ok) throw new Error(`Quote is locked until approval is complete: ${f.reason}`);
  const p = await prisma.proposal.findUniqueOrThrow({ where: { id: proposalId }, include: { account: true, lines: { orderBy: { lineNo: "asc" } } } });
  const totals = await quoteTotals(proposalId);
  if (totals.taxStale) throw new Error("Tax was calculated before the latest price change — recalculate it (Freight & tax) before exporting");
  const branding = await getBranding();
  const owner = p.ownerUserId ? await prisma.user.findUnique({ where: { id: p.ownerUserId }, select: { name: true, email: true } }) : null;
  const shipTo = p.shipToJson ? (JSON.parse(p.shipToJson) as Record<string, string | null>) : p.account.shipToJson ? (JSON.parse(p.account.shipToJson) as Record<string, string | null>) : null;
  const lines = p.lines.filter((l) => l.included && money(l.proposedPrice)).map((l) => ({
    code: l.competitorCode, codeDescription: l.competitorDescription ?? "", sku: l.sku ?? "", description: l.description ?? "",
    equivalence: (l.equivalenceLevel ?? "").replace(/_/g, " ").toLowerCase() || null,
    qty: money(l.quantity)!.toString(), unit: round(money(l.proposedPrice)!, p.currency).toString(), extended: round(times(l.proposedPrice, l.quantity)!, p.currency).toString(),
    note: l.customerNote,
  }));
  const spec: DocSpec = {
    kind: "quote", title: branding.quoteTitle, reference: p.reference,
    customer: { name: p.account.name, accountNumber: p.account.accountNumber, address: shipTo ? [shipTo.line1, shipTo.line2, [shipTo.city, shipTo.region, shipTo.postalCode].filter(Boolean).join(", ")].filter(Boolean) as string[] : null },
    preparedBy: owner ? { name: owner.name, email: owner.email } : { name: actor.name, email: actor.email },
    date: new Date(), validThrough: p.validThrough,
    intro: p.gpoNameSnapshot ? `Pricing reflects ${p.account.name}'s eligibility under ${p.gpoNameSnapshot}.` : null,
    lines,
    totals: { currency: p.currency, subtotal: totals.subtotal.toString(), freight: totals.freightMode === "NONE" ? null : totals.freight.toString(), freightLabel: totals.freightMode === "PCT" ? `Freight (${money(p.freightValue)?.toString() ?? "0"}%)` : "Freight", tax: totals.taxMode === "NONE" ? null : (totals.tax ?? ZERO).toString(), taxLabel: totals.taxMode === "EXEMPT" ? `Tax (exempt${p.taxExemptionNo ? ` · ${p.taxExemptionNo}` : ""})` : totals.taxNote ? `Tax (${totals.taxNote})` : "Tax", total: totals.total.toString() },
    notes: [
      ...(p.lines.some((l) => !l.included) ? [`${p.lines.filter((l) => !l.included).length} item(s) on the usage list are not included in this quotation; your representative will follow up on these.`] : []),
      ...(totals.freightMode === "NONE" ? ["Freight is not included unless otherwise agreed."] : []),
    ],
    terms: branding.quoteTerms, branding,
  };
  const buffer = await renderDocument(spec);
  const filename = `Crosswalk_Quote_${p.reference}_${safe(p.account.name)}_${stamp()}.pdf`;
  await audit({ actorUserId: actor.id, entityType: "Proposal", entityId: proposalId, action: "EXPORTED", context: { format: "pdf", filename, validThrough: p.validThrough?.toISOString() ?? null, total: totals.total.toString() } });
  return { filename, buffer, contentType: "application/pdf" };
}

/** The contract-offer PDF from a cross-reference run (pre-proposal; list / pricebook prices). */
export async function buildOfferPdf(actor: Actor, requestId: string): Promise<{ filename: string; buffer: Buffer; contentType: string }> {
  const r = await prisma.request.findUniqueOrThrow({ where: { id: requestId }, include: { company: true, pricebook: true, account: true, lines: { orderBy: { lineNo: "asc" }, include: { competitorProduct: true, candidates: { orderBy: { rank: "asc" }, include: { ownProduct: true } } } } } });
  const branding = await getBranding();
  let subtotal = ZERO;
  const lines: DocSpec["lines"] = [];
  for (const line of r.lines) {
    const sel = line.candidates.find((c) => c.id === line.selectedCandidateId) ?? line.candidates.find((c) => c.isSelected);
    if (!sel || sel.matchType === "No Match" || sel.unitPrice == null) continue;
    const ext = round(times(sel.unitPrice, line.quantity)!, "USD");
    subtotal = subtotal.plus(ext);
    lines.push({ code: line.rawCode, codeDescription: line.competitorProduct?.description ?? "", sku: sel.ownProduct.sku, description: sel.ownProduct.description + (sel.additionalProducts ? ` (requires ${sel.additionalProducts})` : ""), equivalence: sel.matchType.replace(/ Match$/, "").toLowerCase(), qty: String(line.quantity), unit: round(money(sel.unitPrice)!, "USD").toString(), extended: ext.toString(), note: line.customerNote });
  }
  const unmatched = r.lines.filter((l) => !l.candidates.some((c) => c.id === l.selectedCandidateId && c.matchType !== "No Match"));
  const validThrough = new Date(Date.now() + branding.validityDays * 86_400_000);
  const spec: DocSpec = {
    kind: "offer", title: branding.offerTitle, reference: r.reference,
    customer: { name: r.accountName ?? r.account?.name ?? "Customer", accountNumber: r.accountNumber ?? r.account?.accountNumber ?? null, address: null },
    preparedBy: { name: actor.name, email: actor.email },
    date: new Date(), validThrough,
    intro: `Pricing basis: ${r.pricebook?.name ?? "list price"}. Equivalents are proposed on the basis of intended use, size and construction.`,
    lines,
    totals: { currency: "USD", subtotal: subtotal.toString(), freight: null, tax: null, total: subtotal.toString() },
    notes: [
      unmatched.length ? `${unmatched.length} item(s) on your usage list were not included in this offer (${unmatched.slice(0, 8).map((l) => l.rawCode).join(", ")}${unmatched.length > 8 ? ", …" : ""}). Your representative will follow up on these.` : "All items on your usage list are addressed above.",
      "Prices are per unit and exclude tax and freight unless otherwise agreed.",
    ],
    terms: branding.offerTerms, branding,
  };
  const buffer = await renderDocument(spec);
  await audit({ actorUserId: actor.id, entityType: "Request", entityId: requestId, action: "EXPORTED", context: { format: "pdf", type: "offer", lines: lines.length, total: subtotal.toString() } });
  return { filename: `${safe(r.company.name)}_Contract_Offer_${safe(r.accountName ?? r.reference)}_${stamp()}.pdf`, buffer, contentType: "application/pdf" };
}
