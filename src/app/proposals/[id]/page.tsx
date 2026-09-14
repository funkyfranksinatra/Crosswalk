import { ProposalWorkspace } from "./workspace";
export default async function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProposalWorkspace id={id} />;
}
