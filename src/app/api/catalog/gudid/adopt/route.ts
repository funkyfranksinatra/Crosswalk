import { handle, body } from "@/lib/api";
import { adoptRecords } from "@/lib/gudid/library";

/** Add specific library records to our catalog (the per-row "Add to our catalog" button). */
export async function POST(req: Request) {
  return handle("manage_catalog", async () => {
    const b = await body<{ recordKeys?: string[] }>(req);
    const keys = (b.recordKeys ?? []).filter(Boolean).slice(0, 500);
    if (!keys.length) throw new Error("No records selected");
    const added = await adoptRecords(keys);
    return { added };
  });
}
