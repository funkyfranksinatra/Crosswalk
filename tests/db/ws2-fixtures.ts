/**
 * WS2 fixtures — isolated commercial data for the database-backed WS2 suites.
 * Everything is tagged with a per-run prefix (WS2<run>) so the seeded demo data that
 * scripts/test-enterprise.ts depends on is never touched, and `cleanupRun` removes it.
 */
import { prisma } from "@/lib/db";
import { permissionsFor } from "@/lib/auth/permissions";
import type { Actor } from "@/lib/auth";
import { getCompany } from "@/lib/settings";
import { createFromRequest } from "@/lib/proposals/service";
import { DEFAULT_POLICY, type Policy } from "@/lib/pricing/policy-model";

export const RUN = `ws2${Date.now().toString(36)}`;
/** The product family every fixture product uses unless told otherwise; `mkPolicy` gives it a known ACTIVE policy. */
export const FAMILY = `${RUN} Family`;
export const day = (s: string) => new Date(s + "T00:00:00Z");

export function actorFor(u: { id: string; email: string; name: string }, roles: string[]): Actor {
  return { id: u.id, email: u.email, name: u.name, roles, permissions: permissionsFor(roles), isDev: true };
}

export async function mkUser(tag: string, roles: string[]) {
  const u = await prisma.user.create({ data: { email: `${RUN}.${tag}@test.local`, name: `${RUN} ${tag}`, roles: { create: roles.map((role) => ({ role })) } } });
  return { row: u, actor: actorFor(u, roles) };
}

export async function mkProduct(o: { sku: string; listPrice?: string | null; cogs?: string | null; category?: string | null; currency?: string; description?: string; isActive?: boolean; status?: string | null }) {
  const company = await getCompany();
  return prisma.ownProduct.create({ data: { companyId: company.id, sku: `${RUN}-${o.sku}`.toUpperCase(), description: o.description ?? `${o.sku} fixture`, category: o.category ?? FAMILY, listPrice: o.listPrice ?? null, cogs: o.cogs ?? null, currency: o.currency ?? "USD", isActive: o.isActive ?? true, status: o.status ?? "In Commercial Distribution", source: "manual" } });
}

/** An ACTIVE pricing policy for a family (defaults = DEFAULT_POLICY: target 0.45, min 0.30, COST_PLUS_MIN_MARGIN, MATCH). */
export async function mkPolicy(family = FAMILY, over: Partial<Omit<Policy, "id" | "version" | "status" | "productFamily">> = {}, status = "ACTIVE") {
  const p = { ...DEFAULT_POLICY, ...over };
  const last = await prisma.pricingPolicy.findFirst({ where: { productFamily: family }, orderBy: { version: "desc" } });
  return prisma.pricingPolicy.create({ data: { productFamily: family, version: (last?.version ?? 0) + 1, status, targetMarginPct: p.targetMarginPct, minMarginPct: p.minMarginPct, floorMethod: p.floorMethod, floorParamsJson: JSON.stringify(p.floorParams), defaultStrategy: p.defaultStrategy, defaultAdjustmentPct: p.defaultAdjustmentPct, classification: p.classification, strategicImportance: p.strategicImportance, authorityJson: JSON.stringify(p.authority), approvalRulesJson: JSON.stringify(p.approvalRules) } });
}

export async function mkAccount(o: { name: string; region?: string | null; isStrategic?: boolean; parentAccountId?: string | null; currency?: string; shipToJson?: string | null; ownerUserId?: string | null } ) {
  return prisma.account.create({ data: { name: `${RUN} ${o.name}`, accountNumber: `${RUN}-${o.name.replace(/\W+/g, "")}`.slice(0, 40), region: o.region ?? "US-East", isStrategic: o.isStrategic ?? false, parentAccountId: o.parentAccountId ?? null, currency: o.currency ?? "USD", shipToJson: o.shipToJson ?? null, ownerUserId: o.ownerUserId ?? null } });
}

export async function mkGpo(name: string) {
  return prisma.gpo.create({ data: { name: `${RUN} ${name}` } });
}

export async function mkMembership(accountId: string, gpoId: string, tier: string | null, from: Date, to: Date | null = null) {
  return prisma.gpoMembership.create({ data: { accountId, gpoId, tier, effectiveFrom: from, effectiveTo: to } });
}

export type EntrySpec = { productId: string; price: string; minQty?: string | null; maxQty?: string | null; effectiveFrom?: Date; effectiveTo?: Date | null; status?: string; approvalState?: string; currency?: string; volumeTierName?: string | null; tier?: string | null };

export async function mkContract(o: { number: string; type: "NATIONAL" | "GPO" | "IDN" | "LOCAL"; accountId?: string | null; parentAccountId?: string | null; gpoId?: string | null; tier?: string | null; currency?: string; status?: string; effectiveFrom?: Date; effectiveTo?: Date | null; precedence?: number; scopes?: { productFamily?: string | null; productId?: string | null }[]; entries?: EntrySpec[] }) {
  const from = o.effectiveFrom ?? day("2025-01-01");
  return prisma.contract.create({
    data: {
      contractNumber: `${RUN}-${o.number}`, name: `${RUN} ${o.number}`, type: o.type, status: o.status ?? "ACTIVE", accountId: o.accountId ?? null, parentAccountId: o.parentAccountId ?? null, gpoId: o.gpoId ?? null, tier: o.tier ?? null,
      currency: o.currency ?? "USD", effectiveFrom: from, effectiveTo: o.effectiveTo === undefined ? day("2030-12-31") : o.effectiveTo, precedence: o.precedence ?? 0,
      scopes: { create: (o.scopes ?? []).map((s) => ({ productFamily: s.productFamily ?? null, productId: s.productId ?? null })) },
      entries: { create: (o.entries ?? []).map((e) => ({ productId: e.productId, price: e.price, currency: e.currency ?? o.currency ?? "USD", effectiveFrom: e.effectiveFrom ?? from, effectiveTo: e.effectiveTo === undefined ? null : e.effectiveTo, minQty: e.minQty ?? null, maxQty: e.maxQty ?? null, status: e.status ?? "ACTIVE", approvalState: e.approvalState ?? "APPROVED", volumeTierName: e.volumeTierName ?? null, tier: e.tier ?? null, source: "manual", accountId: o.accountId ?? null, gpoId: o.gpoId ?? null })) },
    },
    include: { entries: true, scopes: true },
  });
}

export type LineSpec = { code: string; qty: number; productId?: string | null; estCompetitorPrice?: string | null; customerNote?: string | null; description?: string | null };

/** A completed cross-reference request with one selected candidate per line (no matcher run). */
export async function mkRequest(o: { accountId: string | null; lines: LineSpec[]; pricebookId?: string | null; tag?: string }) {
  const company = await getCompany();
  const account = o.accountId ? await prisma.account.findUniqueOrThrow({ where: { id: o.accountId } }) : null;
  const n = await prisma.request.count();
  const request = await prisma.request.create({ data: { companyId: company.id, reference: `${RUN}-REQ-${o.tag ?? ""}${n + 1}-${Math.random().toString(36).slice(2, 6)}`, accountId: account?.id ?? null, accountNumber: account?.accountNumber ?? null, accountName: account?.name ?? null, status: "complete", useLlm: false, sourceFileName: `${RUN}-fixture`, pricebookId: o.pricebookId ?? null } });
  let lineNo = 0;
  for (const l of o.lines) {
    lineNo++;
    const line = await prisma.requestLine.create({ data: { requestId: request.id, lineNo, rawCode: l.code, cfnNorm: l.code.toUpperCase(), quantity: l.qty, estCompetitorPrice: l.estCompetitorPrice ?? null, customerNote: l.customerNote ?? null, description: l.description ?? null, resolutionStatus: "resolved", matchStatus: l.productId ? "matched" : "no-match" } });
    if (l.productId) {
      const c = await prisma.matchCandidate.create({ data: { lineId: line.id, ownProductId: l.productId, rank: 1, matchType: "Close Match", source: "attribute", score: 0.8, confidence: 0.8, isSelected: true } });
      await prisma.requestLine.update({ where: { id: line.id }, data: { selectedCandidateId: c.id } });
    }
  }
  return request;
}

export async function mkProposal(actor: Actor, o: { accountId: string; lines: LineSpec[]; validDays?: number; asOf?: Date; pricebookId?: string | null }) {
  const request = await mkRequest({ accountId: o.accountId, lines: o.lines, pricebookId: o.pricebookId ?? null });
  const proposal = await createFromRequest(actor, request.id, { accountId: o.accountId, validDays: o.validDays, asOf: o.asOf });
  const lines = await prisma.proposalLine.findMany({ where: { proposalId: proposal.id }, orderBy: { lineNo: "asc" } });
  return { request, proposal, lines };
}

export async function linesOf(proposalId: string) {
  return prisma.proposalLine.findMany({ where: { proposalId }, orderBy: { lineNo: "asc" } });
}

/** Remove everything this run created (safe to call twice). */
export async function cleanupRun() {
  const proposals = await prisma.proposal.findMany({ where: { OR: [{ account: { name: { startsWith: RUN } } }, { request: { sourceFileName: `${RUN}-fixture` } }] }, select: { id: true } });
  const pids = proposals.map((p) => p.id);
  if (pids.length) {
    const lineIds = (await prisma.proposalLine.findMany({ where: { proposalId: { in: pids } }, select: { id: true } })).map((l) => l.id);
    await prisma.competitorPriceObservation.deleteMany({ where: { proposalLineId: { in: lineIds } } });
    await prisma.matchDecision.deleteMany({ where: { proposalLineId: { in: lineIds } } });
    await prisma.purchaseRecord.deleteMany({ where: { proposalId: { in: pids } } });
    await prisma.contract.deleteMany({ where: { externalId: { in: pids } } });
    await prisma.proposal.deleteMany({ where: { id: { in: pids } } });
  }
  await prisma.request.deleteMany({ where: { sourceFileName: `${RUN}-fixture` } });
  await prisma.purchaseRecord.deleteMany({ where: { account: { name: { startsWith: RUN } } } });
  await prisma.competitorPriceObservation.deleteMany({ where: { OR: [{ account: { name: { startsWith: RUN } } }, { competitorSku: { startsWith: RUN.toUpperCase() } }] } });
  await prisma.contract.deleteMany({ where: { contractNumber: { startsWith: `${RUN}-` } } });
  await prisma.gpoMembership.deleteMany({ where: { account: { name: { startsWith: RUN } } } });
  await prisma.account.updateMany({ where: { name: { startsWith: RUN } }, data: { parentAccountId: null } });
  await prisma.account.deleteMany({ where: { name: { startsWith: RUN } } });
  await prisma.gpo.deleteMany({ where: { name: { startsWith: RUN } } });
  await prisma.ownProduct.deleteMany({ where: { sku: { startsWith: RUN.toUpperCase() } } });
  await prisma.pricebook.deleteMany({ where: { name: { startsWith: RUN } } });
  await prisma.pricingPolicy.deleteMany({ where: { productFamily: { startsWith: RUN } } });
  await prisma.approvalDelegation.deleteMany({ where: { OR: [{ from: { email: { startsWith: RUN } } }, { to: { email: { startsWith: RUN } } }] } });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
}

// ---- document parsing helpers (exports) ---------------------------------------------------
import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Text of a PDF: `pdftotext -layout` when installed, else the literal strings of every inflated content stream. */
export function pdfText(buf: Buffer): string {
  try {
    const dir = mkdtempSync(join(tmpdir(), "ws2pdf-"));
    const f = join(dir, "doc.pdf");
    writeFileSync(f, buf);
    try { return execFileSync("pdftotext", [f, "-"], { encoding: "utf8" }); } finally { rmSync(dir, { recursive: true, force: true }); }
  } catch {
    return pdfTextFallback(buf);
  }
}

/**
 * Text of a PDF without poppler: the shown strings of every (inflated) content stream. pdfkit
 * writes text as hex strings inside TJ arrays — `[<4d65647472> 0 <6f6e6963>] TJ` — and other
 * producers use literal strings `(Medtronic) Tj`; both are decoded (latin1 ≈ WinAnsi for the
 * standard fonts, which is all the exports use). One line per text-showing operator.
 * (CI runners have no pdftotext; this used to read only literal strings, so every PDF assertion
 * failed there while passing locally — Sept 26.)
 */
export function pdfTextFallback(buf: Buffer): string {
  const out: string[] = [];
  const src = buf.toString("latin1");
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  const literal = (body: string) => body.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) => (/^[0-7]+$/.test(e) ? String.fromCharCode(parseInt(e, 8)) : ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e));
  const hex = (body: string) => { const h = body.replace(/\s+/g, ""); return Buffer.from(h.length % 2 ? `${h}0` : h, "hex").toString("latin1"); };
  const show = (operand: string) => {
    let text = "";
    for (const t of operand.matchAll(/\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>/g)) text += t[0].startsWith("(") ? literal(t[0].slice(1, -1)) : hex(t[0].slice(1, -1));
    return text;
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let content = m[1];
    try { content = inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"); } catch { /* uncompressed */ }
    for (const op of content.matchAll(/(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)\s*(?:Tj|'|")|\[((?:\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>|[^\]])*)\]\s*TJ/g)) out.push(show(op[1] ?? op[2] ?? ""));
  }
  return out.join("\n");
}

// ---- failure injection inside interactive transactions ------------------------------------
/**
 * Runs `fn` with `prisma.$transaction` wrapped so that, inside the interactive transaction, the
 * `nth` call of `model.method` (or of a top-level `$method` when model is null) throws. Restores
 * the client afterwards. Lets a test force a failure at one step of a transactional workflow.
 */
export async function withTxFailure<T>(at: { model: string | null; method: string; nth?: number; message?: string }, fn: () => Promise<T>): Promise<{ result: T | null; error: Error | null; calls: number }> {
  const orig = prisma.$transaction.bind(prisma);
  let calls = 0;
  const nth = at.nth ?? 1;
  const msg = at.message ?? `injected failure at ${at.model ?? ""}.${at.method}`;
  const bind = (t: object, prop: PropertyKey) => { const v = Reflect.get(t, prop); return typeof v === "function" ? v.bind(t) : v; };
  (prisma as unknown as { $transaction: unknown }).$transaction = (arg: unknown, opts: unknown) => {
    if (typeof arg !== "function") return orig(arg as never, opts as never);
    return orig(async (tx) => {
      const wrapped = new Proxy(tx as object, {
        get(t, prop) {
          if (at.model === null && prop === at.method) return (...a: unknown[]) => { calls++; if (calls === nth) throw new Error(msg); return (Reflect.get(t, prop) as (...x: unknown[]) => unknown).apply(t, a); };
          if (at.model !== null && prop === at.model) {
            const model = Reflect.get(t, prop) as object;
            return new Proxy(model, { get(m, p2) { if (p2 === at.method) return (...a: unknown[]) => { calls++; if (calls === nth) throw new Error(msg); return (Reflect.get(m, p2) as (...x: unknown[]) => unknown).apply(m, a); }; return bind(m, p2); } });
          }
          return bind(t, prop);
        },
      });
      return (arg as (t: unknown) => Promise<unknown>)(wrapped);
    }, opts as never);
  };
  try {
    const result = await fn();
    return { result, error: null, calls };
  } catch (e) {
    return { result: null, error: e as Error, calls };
  } finally {
    (prisma as unknown as { $transaction: unknown }).$transaction = orig;
  }
}
