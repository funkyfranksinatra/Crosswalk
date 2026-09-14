import { handle } from "@/lib/api";
import { winLoss, pricingEffectiveness, conversion, crossReferenceAccuracy } from "@/lib/analytics";
export async function GET(_req: Request, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  return handle("view_analytics", async () => {
    switch (report) {
      case "winloss": return winLoss();
      case "pricing": return pricingEffectiveness();
      case "conversion": return conversion();
      case "accuracy": return crossReferenceAccuracy();
      default: throw new Error("unknown report");
    }
  });
}
