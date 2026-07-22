import Dashboard from "@/components/Dashboard";

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  return <Dashboard entryId={parseInt(id, 10)} initialTab={tab} />;
}
