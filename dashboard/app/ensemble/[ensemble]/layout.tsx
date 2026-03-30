import { EnsembleSidebar } from "@/components/dashboard/EnsembleSidebar";

export default async function EnsembleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ ensemble: string }>;
}) {
  const { ensemble } = await params;

  return (
    <div className="grid h-full grid-cols-[240px_1fr]">
      <EnsembleSidebar ensembles={[ensemble]} activeEnsemble={ensemble} />
      <div className="flex h-full flex-col overflow-hidden">{children}</div>
    </div>
  );
}
