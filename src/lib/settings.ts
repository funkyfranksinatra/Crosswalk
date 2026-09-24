import { defaultLabelers } from "@/lib/tenancy";
import { prisma } from "@/lib/db";
import { DEFAULT_WEIGHTS, type Weights } from "@/lib/match/score";

export type Settings = {
  weights: Weights;
  maxCandidates: number;
  companyName: string;
};

export async function getSettings(): Promise<Settings> {
  const rows = await prisma.setting.findMany();
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let weights = DEFAULT_WEIGHTS;
  try {
    if (map.weights) weights = { ...DEFAULT_WEIGHTS, ...JSON.parse(map.weights) };
  } catch {}
  return {
    weights,
    maxCandidates: Number(map.maxCandidates ?? 5) || 5,
    companyName: map.companyName ?? process.env.COMPANY_NAME ?? "Medtronic",
  };
}

export async function saveSettings(patch: Partial<Settings>) {
  const writes: [string, string][] = [];
  if (patch.weights !== undefined) {
    if (!patch.weights || typeof patch.weights !== "object") throw new Error("weights must be an object");
    const w: Record<string, number> = {};
    for (const k of Object.keys(DEFAULT_WEIGHTS)) {
      const v = (patch.weights as Record<string, unknown>)[k];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10) throw new Error(`weight ${k} must be a number between 0 and 10`);
      w[k] = v;
    }
    if (Object.values({ ...DEFAULT_WEIGHTS, ...w }).every((v) => v === 0)) throw new Error("at least one ranking weight must be positive");
    writes.push(["weights", JSON.stringify({ ...DEFAULT_WEIGHTS, ...w })]);
  }
  if (patch.maxCandidates !== undefined) {
    const n = Number(patch.maxCandidates);
    if (!Number.isInteger(n) || n < 1 || n > 25) throw new Error("maxCandidates must be an integer between 1 and 25");
    writes.push(["maxCandidates", String(n)]);
  }
  if (patch.companyName !== undefined) {
    const name = String(patch.companyName).trim();
    if (!name || name.length > 120) throw new Error("companyName must be 1–120 characters");
    // Renaming the company renames the *existing* company row: the catalog, requests and prices
    // hang off it, and a second Company row would make them all vanish from the UI.
    const current = await getCompany();
    if (current.name !== name) {
      if (await prisma.company.findUnique({ where: { name } })) throw new Error(`a company named "${name}" already exists`);
      await prisma.company.update({ where: { id: current.id }, data: { name } });
    }
    writes.push(["companyName", name]);
  }
  for (const [key, value] of writes) {
    await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
}

export async function getCompany() {
  const s = await getSettings();
  const byName = await prisma.company.findUnique({ where: { name: s.companyName } });
  if (byName) return byName;
  // Single-tenant: if a company exists under another name, it *is* the company (settings drifted).
  const only = await prisma.company.findFirst({ orderBy: { createdAt: "asc" } });
  if (only) return only;
  return prisma.company.create({ data: { name: s.companyName, labelers: JSON.stringify(defaultLabelers()) } });
}
