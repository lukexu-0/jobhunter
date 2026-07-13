import { RunDetail } from "../../components/run-detail";

interface RunPageProps {
  readonly params: Promise<{ id: string }>;
}

export default async function RunPage({ params }: RunPageProps) {
  const { id } = await params;
  return <RunDetail runId={id} />;
}
