import { prisma } from "@/lib/db";
import { handle, body } from "@/lib/api";
import { quoteTotals, setProposalLogistics, calculateProposalTax, taxProviderStatus, type LogisticsInput } from "@/lib/tax";

/** Freight & tax on a proposal: read the totals, set the modes, calculate. Never touches line economics. */
function view(p: { freightMode: string; freightValue: unknown; taxMode: string; taxRate: unknown; taxExemptionNo: string | null; shipToJson: string | null; taxProvider: string | null; taxDetailJson: string | null }, totals: Awaited<ReturnType<typeof quoteTotals>>) {
  const detail = p.taxDetailJson ? (JSON.parse(p.taxDetailJson) as Record<string, unknown>) : null;
  return {
    freightMode: p.freightMode, freightValue: p.freightValue?.toString() ?? null, taxMode: p.taxMode, taxRate: p.taxRate?.toString() ?? null, taxExemptionNo: p.taxExemptionNo, shipTo: p.shipToJson ? JSON.parse(p.shipToJson) : null, taxProvider: p.taxProvider,
    totals: { currency: totals.currency, subtotal: totals.subtotal.toString(), freight: totals.freight.toString(), tax: totals.tax?.toString() ?? null, total: totals.total.toString(), taxCalculatedAt: totals.taxCalculatedAt?.toISOString() ?? null, taxStale: totals.taxStale, taxNote: totals.taxNote },
    summary: detail?.summary ?? null, service: taxProviderStatus(),
  };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("view_pricing", async () => { const p = await prisma.proposal.findUniqueOrThrow({ where: { id } }); return view(p, await quoteTotals(id)); });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("edit_proposed_pricing", async (actor) => { const b = await body<LogisticsInput>(req); const p = await setProposalLogistics(actor, id, b); return view(p, await quoteTotals(id)); });
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handle("edit_proposed_pricing", async (actor) => { await calculateProposalTax(actor, id); const p = await prisma.proposal.findUniqueOrThrow({ where: { id } }); return view(p, await quoteTotals(id)); });
}
