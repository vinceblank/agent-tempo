"use client";

import { use } from "react";
import { EnsembleSidebar } from "@/components/dashboard/EnsembleSidebar";
import { useEnsembles } from "@/hooks/useEnsembles";

export default function EnsembleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ ensemble: string }>;
}) {
  const { ensemble } = use(params);
  const { data } = useEnsembles();
  const ensembles = data?.ensembles ?? [ensemble];

  return (
    <div className="grid h-full grid-cols-[240px_1fr]">
      <EnsembleSidebar ensembles={ensembles} activeEnsemble={ensemble} />
      <div className="flex h-full flex-col overflow-hidden">{children}</div>
    </div>
  );
}
