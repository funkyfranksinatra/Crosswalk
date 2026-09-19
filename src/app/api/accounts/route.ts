import { prisma } from "@/lib/db";
import { handle, body, str, requireText, optText, oneOf, currencyCode } from "@/lib/api";
import { audit } from "@/lib/audit";
import { scopeFor, accountWhere } from "@/lib/auth/scope";
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return handle("view_pricing", async (actor) => prisma.account.findMany({ where: { AND: [accountWhere(await scopeFor(actor)), q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { accountNumber: { contains: q } }] } : {}] }, orderBy: { name: "asc" }, include: { parent: true, memberships: { include: { gpo: true } }, _count: { select: { contracts: true, proposals: true } } }, take: 200 }));
}
export async function POST(req: Request) {
  return handle("manage_contracts", async (actor) => {
    const b = await body<Record<string, unknown>>(req);
    if (str(b.parentAccountId) && !(await prisma.account.findUnique({ where: { id: String(b.parentAccountId) }, select: { id: true } }))) throw new Error("unknown parentAccountId");
    if (str(b.ownerUserId) && !(await prisma.user.findUnique({ where: { id: String(b.ownerUserId) }, select: { id: true } }))) throw new Error("unknown ownerUserId");
    const a = await prisma.account.create({ data: { name: requireText(b.name, "name"), accountNumber: optText(b.accountNumber, "accountNumber", 40), type: oneOf(b.type, ["SOLD_TO", "SHIP_TO", "BILL_TO", "IDN", "GPO_MEMBER"] as const, "type", "SOLD_TO"), parentAccountId: str(b.parentAccountId), territory: optText(b.territory, "territory", 80), segment: optText(b.segment, "segment", 80), region: optText(b.region, "region", 80), country: requireText(b.country ?? "US", "country", 2), currency: currencyCode(b.currency), isStrategic: Boolean(b.isStrategic), ownerUserId: str(b.ownerUserId) } });
    await audit({ actorUserId: actor.id, entityType: "Account", entityId: a.id, action: "CREATED", after: { name: a.name } });
    return a;
  });
}
