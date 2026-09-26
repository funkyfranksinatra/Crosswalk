/**
 * Decisions that used to need a person with a spreadsheet, settled inside Crosswalk:
 *
 *  - Evidence conflicts (src/lib/xref/conflicts.ts): a run whose product attributes contradict a
 *    curated row queues the row; a reviewer retires / replaces / keeps it; runs never wait;
 *    a KEEP survives later runs and a re-seed; RETIRE / REPLACE drop the row from the matcher's
 *    inputs and from the next published version.
 *  - Account visibility for children of an unassigned parent (B-08): a per-company setting with
 *    the narrow default, read by scopeFor.
 *
 * Needs DATABASE_URL (the disposable local DB); no network.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "@/lib/db";
import { heuristicBin } from "@/lib/match/bin";
import { scoreCandidates, type CandidateInput } from "@/lib/match/score";
import { recordCuratedConflicts, decideConflict, openConflicts, parseConflict } from "@/lib/xref/conflicts";
import { publishVersion } from "@/lib/xref/governance";
import { crossesForMatching } from "@/lib/xref/learning";
import { getSettings, saveSettings } from "@/lib/settings";
import { scopeFor, accountWhere, SCOPE_UNASSIGNED_PARENT_KEY } from "@/lib/auth/scope";
import { permissionsFor } from "@/lib/auth/permissions";
import type { Actor } from "@/lib/auth";

const hasDb = Boolean(process.env.DATABASE_URL);
const TAG = `dc${Date.now().toString(36)}`.toUpperCase();

const own = (sku: string, description: string, extra: Partial<CandidateInput> = {}): CandidateInput => ({ ownProductId: sku, sku, description, bin: heuristicBin({ sku, manufacturer: "Medtronic", description, category: "Trocar Products" }), unitPrice: null, cogs: null, provenance: "seed", ...extra });
const comp = (code: string, description: string) => ({ bin: heuristicBin({ code, manufacturer: "Ethicon", description, intakeDescription: null }), description, estPrice: null });

const base = { competitorName: "Ethicon", source: `${TAG}-sheet`, approvalStatus: "APPROVED", clinicalReviewStatus: "NOT_REQUIRED", marketingReviewStatus: "NOT_REQUIRED", equivalenceLevel: "EXACT", category: "Trocar Products" };

describe.skipIf(!hasDb)("evidence conflicts on curated crosses", () => {
  let reviewer: { id: string };
  let sleeveRow: { id: string };
  let softRow: { id: string };
  beforeAll(async () => {
    reviewer = await prisma.user.create({ data: { email: `${TAG.toLowerCase()}.reviewer@test.local`, name: `${TAG} reviewer`, roles: { create: [{ role: "PRODUCT_MARKETING" }] } } });
    // Hard contradiction: the sheet crosses an optical trocar to a cannula-only SKU.
    sleeveRow = await prisma.knownCross.create({ data: { ...base, ownSku: `${TAG}-SLEEVE`, ownDescription: "VersaOne Universal Fixation Cannula; Size: 5 mm; Length: 70 mm", competitorCode: `${TAG}-2B5XT`, competitorCodeNorm: `${TAG}-2B5XT`, competitorDescription: "ENDOPATH XCEL OPTIVIEW Bladeless Trocars with Stability Sleeves", matchType: "Exact Match" } });
    // Soft contradiction: a dilating-tip trocar crossed Exact to a bladed one.
    softRow = await prisma.knownCross.create({ data: { ...base, ownSku: `${TAG}-BLADED`, ownDescription: "VersaOne Bladed Trocar with Fixation Cannula; 11 mm x 100 mm", competitorCode: `${TAG}-D11LT`, competitorCodeNorm: `${TAG}-D11LT`, competitorDescription: "ENDOPATH XCEL Dilating Tip Trocars with Stability Sleeves; 100 mm x 11 mm", matchType: "Exact Match" } });
  });
  afterAll(async () => {
    await prisma.crosswalkVersionEntry.deleteMany({ where: { competitorCodeNorm: { startsWith: `${TAG}-` } } }).catch(() => undefined);
    await prisma.knownCross.deleteMany({ where: { competitorCodeNorm: { startsWith: `${TAG}-` } } });
    await prisma.auditEvent.deleteMany({ where: { actorUserId: reviewer.id } }).catch(() => undefined);
    await prisma.user.delete({ where: { id: reviewer.id } }).catch(() => undefined);
  });

  const scoreSleeve = async () => {
    const row = await prisma.knownCross.findUniqueOrThrow({ where: { id: sleeveRow.id } });
    return scoreCandidates(comp(`${TAG}-2B5XT`, "ENDOPATH XCEL OPTIVIEW Bladeless Trocars with Stability Sleeves"), [
      own(`${TAG}-SLEEVE`, "VersaOne Universal Fixation Cannula; Size: 5 mm; Length: 70 mm", { knownCross: { id: row.id, matchType: row.matchType, source: row.source, approvalStatus: row.approvalStatus, kept: row.conflictStatus === "KEPT" } }),
      own(`${TAG}-OPTICAL`, "VersaOne Optical Trocar with Fixation Cannula; 5 mm x 100 mm"),
    ]);
  };
  const scoreSoft = async () => {
    const row = await prisma.knownCross.findUniqueOrThrow({ where: { id: softRow.id } });
    return scoreCandidates(comp(`${TAG}-D11LT`, "ENDOPATH XCEL Dilating Tip Trocars with Stability Sleeves; 100 mm x 11 mm"), [
      own(`${TAG}-BLADED`, "VersaOne Bladed Trocar with Fixation Cannula; 11 mm x 100 mm", { knownCross: { id: row.id, matchType: row.matchType, source: row.source, approvalStatus: row.approvalStatus, kept: row.conflictStatus === "KEPT" } }),
    ]);
  };

  test("a run queues the contradicted rows with findings, the ranked grade and the evidence's first choice; the run itself is not blocked", async () => {
    const sleeve = await scoreSleeve();
    const soft = await scoreSoft();
    expect(sleeve.find((s) => s.sku === `${TAG}-SLEEVE`)!.factors.curated).toMatchObject({ contradicted: true, knownCrossId: sleeveRow.id, effective: "No Match" });
    expect(soft[0].factors.curated).toMatchObject({ contradicted: true, knownCrossId: softRow.id, effective: "Close Match" });
    const queued = await recordCuratedConflicts(`${TAG}-REQ`, [{ code: `${TAG}-2B5XT`, scored: sleeve }, { code: `${TAG}-D11LT`, scored: soft }]);
    expect(queued).toBe(2);
    const open = await openConflicts();
    const s = open.find((r) => r.id === sleeveRow.id)!;
    expect(s.conflictStatus).toBe("CONTRADICTED");
    expect(s.conflictCount).toBe(1);
    expect(s.conflict).toMatchObject({ suggestedSku: `${TAG}-OPTICAL`, effective: "No Match", sheetGrade: "Exact Match", requestReference: `${TAG}-REQ`, lineCode: `${TAG}-2B5XT` });
    expect(s.conflict!.findings.join(" ")).toMatch(/cannula only|component/i);
    const d = open.find((r) => r.id === softRow.id)!;
    expect(d.conflict!.suggestedSku).toBeNull(); // the row's own SKU still ranked first, only lower
    expect(d.conflict!.findings.length).toBeGreaterThan(0);
    // A second run refreshes the entry and counts it, without duplicating it.
    await recordCuratedConflicts(`${TAG}-REQ2`, [{ code: `${TAG}-2B5XT`, scored: sleeve }]);
    const again = await prisma.knownCross.findUniqueOrThrow({ where: { id: sleeveRow.id } });
    expect(again.conflictCount).toBe(2);
    expect(parseConflict(again.conflictJson)!.requestReference).toBe(`${TAG}-REQ2`);
  });

  test("KEEP holds the sheet grade against soft findings in later runs, survives a re-run and a seed-style refresh, and is never re-queued", async () => {
    const before = await scoreSoft();
    expect(before[0].matchType).toBe("Close Match");
    const r = await decideConflict(reviewer.id, softRow.id, "KEEP", "Sales engineering confirmed the substitution");
    expect(r.decision).toBe("KEEP");
    const row = await prisma.knownCross.findUniqueOrThrow({ where: { id: softRow.id } });
    expect(row).toMatchObject({ conflictStatus: "KEPT", approvalStatus: "APPROVED", conflictDecidedByUserId: reviewer.id, conflictNote: "Sales engineering confirmed the substitution" });
    const after = await scoreSoft();
    expect(after[0].matchType).toBe("Exact Match");
    expect(after[0].factors.curated).toMatchObject({ kept: true, contradicted: false });
    expect(after[0].factors.notes.join(" ")).toMatch(/kept by a reviewer/);
    // A later run reports nothing for a kept row; the queue entry is not reopened.
    expect(await recordCuratedConflicts(`${TAG}-REQ3`, [{ code: `${TAG}-D11LT`, scored: after }])).toBe(0);
    // What prisma/seed.ts refreshes on an existing row never touches the decision.
    await prisma.knownCross.update({ where: { id: softRow.id }, data: { matchType: "Exact Match", competitorDescription: row.competitorDescription, preferredOwnSku: null } });
    expect((await prisma.knownCross.findUniqueOrThrow({ where: { id: softRow.id } })).conflictStatus).toBe("KEPT");
    expect((await openConflicts()).some((c) => c.id === softRow.id)).toBe(false);
    // Deciding again is refused: there is no open conflict.
    await expect(decideConflict(reviewer.id, softRow.id, "RETIRE")).rejects.toThrow(/no open evidence conflict/);
  });

  test("KEEP does not hold against a hard finding: a sleeve is never confirmed into a trocar", async () => {
    await prisma.knownCross.update({ where: { id: sleeveRow.id }, data: { conflictStatus: "KEPT" } });
    const scored = await scoreSleeve();
    const sleeve = scored.find((s) => s.sku === `${TAG}-SLEEVE`)!;
    expect(sleeve.matchType).toBe("No Match");
    expect(sleeve.factors.curated).toMatchObject({ contradicted: true, kept: undefined });
    await prisma.knownCross.update({ where: { id: sleeveRow.id }, data: { conflictStatus: "CONTRADICTED" } });
  });

  test("REPLACE retires the row and records the evidence-based cross as an approved row; the matcher and the next publish carry the replacement", async () => {
    const r = await decideConflict(reviewer.id, sleeveRow.id, "REPLACE");
    expect(r.replacement?.ownSku).toBe(`${TAG}-OPTICAL`);
    const old = await prisma.knownCross.findUniqueOrThrow({ where: { id: sleeveRow.id } });
    expect(old).toMatchObject({ approvalStatus: "RETIRED", conflictStatus: null, conflictDecidedByUserId: reviewer.id });
    expect(old.effectiveTo).not.toBeNull();
    expect(old.justification).toMatch(/Retired from Evidence conflicts \(replace\)/);
    const repl = await prisma.knownCross.findUniqueOrThrow({ where: { id: r.replacement!.id } });
    expect(repl).toMatchObject({ ownSku: `${TAG}-OPTICAL`, competitorCodeNorm: `${TAG}-2B5XT`, source: "evidence", approvalStatus: "APPROVED", marketingReviewStatus: "APPROVED", clinicalReviewStatus: "NOT_REQUIRED", reviewerUserId: reviewer.id });
    expect(JSON.parse(repl.evidenceJson!)).toMatchObject({ from: "evidence-conflict", replaced: sleeveRow.id, line: `${TAG}-2B5XT` });
    const forMatching = await crossesForMatching();
    const mine = forMatching.filter((k) => k.competitorCodeNorm === `${TAG}-2B5XT`);
    expect(mine.map((k) => k.ownSku)).toEqual([`${TAG}-OPTICAL`]);
    const { version } = await publishVersion(reviewer.id, `${TAG} publish`);
    const entries = await prisma.crosswalkVersionEntry.findMany({ where: { versionId: version.id, competitorCodeNorm: { startsWith: `${TAG}-` } } });
    expect(entries.map((e) => e.ownSku).sort()).toEqual([`${TAG}-BLADED`, `${TAG}-OPTICAL`]);
    const audit = await prisma.auditEvent.findFirst({ where: { entityId: sleeveRow.id, action: "CONFLICT_REPLACE" } });
    expect(audit).not.toBeNull();
  });

  test("RETIRE without a suggested SKU, and REPLACE is refused when the evidence ranked no other product", async () => {
    const lone = await prisma.knownCross.create({ data: { ...base, ownSku: `${TAG}-LONE`, ownDescription: "VersaOne Universal Fixation Cannula; Size: 5 mm; Length: 70 mm", competitorCode: `${TAG}-LONE`, competitorCodeNorm: `${TAG}-LONE`, competitorDescription: "ENDOPATH XCEL OPTIVIEW Bladeless Trocars with Stability Sleeves", matchType: "Exact Match" } });
    const scored = scoreCandidates(comp(`${TAG}-LONE`, "ENDOPATH XCEL OPTIVIEW Bladeless Trocars with Stability Sleeves"), [own(`${TAG}-LONE`, "VersaOne Universal Fixation Cannula; Size: 5 mm; Length: 70 mm", { knownCross: { id: lone.id, matchType: "Exact Match", source: lone.source, approvalStatus: "APPROVED" } })]);
    expect(await recordCuratedConflicts(`${TAG}-REQ4`, [{ code: `${TAG}-LONE`, scored }])).toBe(1);
    await expect(decideConflict(reviewer.id, lone.id, "REPLACE")).rejects.toThrow(/No evidence-based SKU/);
    await decideConflict(reviewer.id, lone.id, "RETIRE", "no equivalent");
    const row = await prisma.knownCross.findUniqueOrThrow({ where: { id: lone.id } });
    expect(row).toMatchObject({ approvalStatus: "RETIRED", conflictStatus: null, conflictNote: "no equivalent" });
    expect((await crossesForMatching()).some((k) => k.id === lone.id)).toBe(false);
    await expect(decideConflict(reviewer.id, lone.id, "BOGUS" as never)).rejects.toThrow(/RETIRE, REPLACE or KEEP/);
  });
});

describe.skipIf(!hasDb)("account visibility: children of an unassigned parent (Settings)", () => {
  const RUN = `t8${Date.now().toString(36)}`;
  let rep: Actor;
  let other: Actor;
  const ids: Record<string, string> = {};
  let previous: string | null = null;
  beforeAll(async () => {
    previous = (await prisma.setting.findUnique({ where: { key: SCOPE_UNASSIGNED_PARENT_KEY } }))?.value ?? null;
    const mk = async (tag: string, roles: string[], territory?: string): Promise<Actor> => {
      const u = await prisma.user.create({ data: { email: `${RUN}.${tag}@test.local`, name: `${RUN} ${tag}`, territory, roles: { create: roles.map((role) => ({ role })) } } });
      return { id: u.id, email: u.email, name: u.name, roles, permissions: permissionsFor(roles), isDev: true };
    };
    rep = await mk("rep", ["SALES_REP"], "Northeast");
    other = await mk("other", ["SALES_REP"], "West");
    const idn = await prisma.account.create({ data: { name: `${RUN} idn`, accountNumber: `${RUN}-idn`, type: "IDN" } }); // nobody owns it, no territory
    ids.idn = idn.id;
    ids.ownedChild = (await prisma.account.create({ data: { name: `${RUN} owned child`, accountNumber: `${RUN}-ownedChild`, parentAccountId: idn.id, ownerUserId: other.id, territory: "West" } })).id;
    ids.freeChild = (await prisma.account.create({ data: { name: `${RUN} free child`, accountNumber: `${RUN}-freeChild`, parentAccountId: idn.id } })).id;
  });
  afterAll(async () => {
    if (previous === null) await prisma.setting.deleteMany({ where: { key: SCOPE_UNASSIGNED_PARENT_KEY } });
    else await prisma.setting.update({ where: { key: SCOPE_UNASSIGNED_PARENT_KEY }, data: { value: previous } });
    await prisma.account.deleteMany({ where: { accountNumber: { startsWith: `${RUN}-` } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: `${RUN}.` } } });
  });
  const visible = async (a: Actor) => (await prisma.account.findMany({ where: { AND: [accountWhere(await scopeFor(a)), { accountNumber: { startsWith: `${RUN}-` } }] }, select: { accountNumber: true } })).map((r) => r.accountNumber!.slice(RUN.length + 1)).sort();

  test("default (own): the unassigned IDN and its unassigned member are visible to everyone; a member with its own owner stays with that owner", async () => {
    await prisma.setting.deleteMany({ where: { key: SCOPE_UNASSIGNED_PARENT_KEY } });
    expect((await getSettings()).scopeUnassignedParent).toBe("own");
    expect(await visible(rep)).toEqual(["freeChild", "idn"]);
    expect(await visible(other)).toEqual(["freeChild", "idn", "ownedChild"]);
  });

  test("inherit: every member follows the unassigned IDN, as before; the setting is validated", async () => {
    await saveSettings({ scopeUnassignedParent: "inherit" });
    expect((await getSettings()).scopeUnassignedParent).toBe("inherit");
    expect(await visible(rep)).toEqual(["freeChild", "idn", "ownedChild"]);
    await saveSettings({ scopeUnassignedParent: "own" });
    expect(await visible(rep)).toEqual(["freeChild", "idn"]);
    await expect(saveSettings({ scopeUnassignedParent: "everyone" as never })).rejects.toThrow(/scopeUnassignedParent/);
  });
});
