import { RequestView } from "./view";

export default async function RequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequestView id={id} />;
}
