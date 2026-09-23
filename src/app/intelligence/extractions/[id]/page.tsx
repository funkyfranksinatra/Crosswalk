import { ExtractionReview } from "./client";
export default async function ExtractionPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <ExtractionReview id={id} />; }
