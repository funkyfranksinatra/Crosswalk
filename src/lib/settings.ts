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
  if (patch.weights) writes.push(["weights", JSON.stringify(patch.weights)]);
  if (patch.maxCandidates) writes.push(["maxCandidates", String(patch.maxCandidates)]);
  if (patch.companyName) writes.push(["companyName", patch.companyName]);
  for (const [key, value] of writes) {
    await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
}

export async function getCompany() {
  const s = await getSettings();
  return prisma.company.upsert({
    where: { name: s.companyName },
    create: { name: s.companyName, labelers: JSON.stringify(["Covidien", "Medtronic", "Sofradim"]) },
    update: {},
  });
}
