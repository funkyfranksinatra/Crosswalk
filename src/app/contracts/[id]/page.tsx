import { ContractView } from "./view";
export default async function ContractPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <ContractView id={id} />; }
