import Dashboard from "@/components/Dashboard";

export default async function TeamPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <Dashboard entryId={parseInt(id, 10)} />;
}
