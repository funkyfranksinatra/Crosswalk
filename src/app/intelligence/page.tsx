import { Intelligence } from "./client";
export default async function IntelligencePage({ searchParams }: { searchParams: Promise<{ sku?: string; accountId?: string }> }) { const s = await searchParams; return <Intelligence sku={s.sku ?? ""} accountId={s.accountId ?? ""} />; }
