import { prisma } from "@/lib/db";
import { handle, body, str } from "@/lib/api";
import { audit } from "@/lib/audit";
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? "";
  return handle("view_pricing", async () => prisma.account.findMany({ where: q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { accountNumber: { contains: q } }] } : {}, orderBy: { name: "asc" }, include: { parent: true, memberships: { include: { gpo: true } }, _count: { select: { contracts: true, proposals: true } } }, take: 200 }));
}
export async function POST(req: Request) {
  return handle("manage_contracts", async (actor) => {
    const b = await body<Record<string, unknown>>(req);
    const a = await prisma.account.create({ data: { name: String(b.name), accountNumber: str(b.accountNumber), type: String(b.type ?? "SOLD_TO"), parentAccountId: str(b.parentAccountId), territory: str(b.territory), segment: str(b.segment), region: str(b.region), country: String(b.country ?? "US"), currency: String(b.currency ?? "USD"), isStrategic: Boolean(b.isStrategic), ownerUserId: str(b.ownerUserId) } });
    await audit({ actorUserId: actor.id, entityType: "Account", entityId: a.id, action: "CREATED", after: { name: a.name } });
    return a;
  });
}
