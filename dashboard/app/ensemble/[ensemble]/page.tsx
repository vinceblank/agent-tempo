"use client";

import { useState, useCallback, useEffect, use } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { PlayerPanel } from "@/components/dashboard/PlayerPanel";
import { FeedPanel } from "@/components/dashboard/FeedPanel";
import { CommandInput } from "@/components/dashboard/CommandInput";
import { RecruitDialog } from "@/components/dashboard/RecruitDialog";
import { usePlayers } from "@/hooks/usePlayers";
import { useConductorHistory } from "@/hooks/useConductorHistory";

export default function EnsemblePage({
  params,
}: {
  params: Promise<{ ensemble: string }>;
}) {
  const { ensemble } = use(params);
  const router = useRouter();
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);

  const { data: players, loading: playersLoading } = usePlayers(ensemble);
  const { data: history, loading: historyLoading } =
    useConductorHistory(ensemble);

  // Auto-start conductor on mount
  useEffect(() => {
    fetch(`/api/ensemble/${encodeURIComponent(ensemble)}/conductor/start`, {
      method: "POST",
    }).catch(() => {});
  }, [ensemble]);

  const handleSendCommand = useCallback(
    async (message: string) => {
      await fetch(`/api/ensemble/${encodeURIComponent(ensemble)}/conductor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message, source: "dashboard" }),
      });
    },
    [ensemble]
  );

  const handleRecruit = useCallback(
    async (data: { name: string; workDir: string; initialMessage?: string }) => {
      await fetch(`/api/ensemble/${encodeURIComponent(ensemble)}/recruit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    },
    [ensemble]
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">{ensemble}</h1>
          <Badge variant="secondary" className="text-xs">
            {playersLoading ? "connecting..." : "running"}
          </Badge>
        </div>
        <RecruitDialog onRecruit={handleRecruit} />
      </div>

      {/* Stats */}
      <StatsBar players={players ?? []} />

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        <PlayerPanel
          players={players ?? []}
          selectedId={selectedPlayerId}
          onSelect={(id) => {
            setSelectedPlayerId(id);
            router.push(
              `/ensemble/${encodeURIComponent(ensemble)}/player/${encodeURIComponent(id)}`
            );
          }}
        />
        <div className="flex flex-1 flex-col overflow-hidden">
          <FeedPanel entries={history ?? []} />
          <CommandInput onSend={handleSendCommand} />
        </div>
      </div>
    </div>
  );
}
