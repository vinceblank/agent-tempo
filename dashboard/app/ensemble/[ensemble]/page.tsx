"use client";

import { useState, useCallback, useEffect, useMemo, use } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StatsBar } from "@/components/dashboard/StatsBar";
import { PlayerPanel } from "@/components/dashboard/PlayerPanel";
import { CommandInput } from "@/components/dashboard/CommandInput";
import { RecruitDialog } from "@/components/dashboard/RecruitDialog";
import { usePlayers } from "@/hooks/usePlayers";
import { useMaestroMessages } from "@/hooks/useMaestroMessages";
import { useMaestroMetadata } from "@/hooks/useMaestroMetadata";
import { useConductorStatus } from "@/hooks/useConductorStatus";
import type { Message, SentMessage } from "@/lib/tempo-types";

type TimelineEntry =
  | { direction: "inbound"; message: Message }
  | { direction: "outbound"; message: SentMessage };

export default function EnsemblePage({
  params,
}: {
  params: Promise<{ ensemble: string }>;
}) {
  const { ensemble } = use(params);
  const router = useRouter();
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);

  const { data: players, loading: playersLoading } = usePlayers(ensemble);
  const { data: maestroData } = useMaestroMessages(ensemble);
  const { data: maestroMetadata } = useMaestroMetadata(ensemble);
  const { data: conductorStatus } = useConductorStatus(ensemble);
  const conductorActive = conductorStatus?.active ?? false;

  // Auto-start maestro on mount
  useEffect(() => {
    fetch(`/api/ensemble/${encodeURIComponent(ensemble)}/maestro/start`, {
      method: "POST",
    }).catch(() => {});
  }, [ensemble]);

  const timeline = useMemo<TimelineEntry[]>(() => {
    if (!maestroData) return [];
    const entries: TimelineEntry[] = [
      ...maestroData.messages.map(
        (m): TimelineEntry => ({ direction: "inbound", message: m })
      ),
      ...maestroData.sentMessages.map(
        (m): TimelineEntry => ({ direction: "outbound", message: m })
      ),
    ];
    entries.sort(
      (a, b) =>
        new Date(a.message.timestamp).getTime() -
        new Date(b.message.timestamp).getTime()
    );
    return entries;
  }, [maestroData]);

  const handleSendCommand = useCallback(
    async (message: string) => {
      await fetch(`/api/ensemble/${encodeURIComponent(ensemble)}/maestro`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "conductor", text: message }),
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
          {playersLoading ? (
            <Badge variant="secondary" className="text-xs">
              connecting...
            </Badge>
          ) : conductorActive ? (
            <Badge variant="secondary" className="text-xs bg-emerald-500/15 text-emerald-500 border-emerald-500/20">
              running
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-xs bg-yellow-500/15 text-yellow-500 border-yellow-500/20">
              no conductor
            </Badge>
          )}
        </div>
        <RecruitDialog onRecruit={handleRecruit} defaultWorkDir={maestroMetadata?.workDir} />
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
          {/* Maestro Chat Timeline */}
          <ScrollArea className="flex-1 overflow-hidden">
            <div className="space-y-3 p-4">
              {timeline.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  No messages yet
                </p>
              ) : (
                timeline.map((entry) => {
                  const isOutbound = entry.direction === "outbound";
                  const msg = entry.message;
                  const timestamp = new Date(msg.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  });

                  return (
                    <div
                      key={msg.id}
                      className={cn(
                        "max-w-[80%]",
                        isOutbound && "ml-auto"
                      )}
                    >
                      <div
                        className={cn(
                          "flex items-center gap-2 text-[10px] text-muted-foreground",
                          isOutbound && "justify-end"
                        )}
                      >
                        {isOutbound ? (
                          <>
                            <span>{timestamp}</span>
                            <span className="font-medium">
                              To {(msg as SentMessage).to}
                            </span>
                          </>
                        ) : (
                          <>
                            <span className="font-medium">
                              From {(msg as Message).from}
                            </span>
                            <span>{timestamp}</span>
                            {(msg as Message).delivered ? (
                              <Check className="h-3 w-3 text-emerald-500" />
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-[10px] border-warning/50 text-warning"
                              >
                                pending
                              </Badge>
                            )}
                          </>
                        )}
                      </div>
                      <div
                        className={cn(
                          "mt-1 rounded-lg px-3 py-2 text-sm",
                          isOutbound
                            ? "bg-primary/10 border border-primary/20"
                            : (msg as Message).delivered
                              ? "bg-muted"
                              : "bg-muted border border-warning/30"
                        )}
                      >
                        <p className="whitespace-pre-wrap break-words">
                          {msg.text}
                        </p>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>

          {conductorActive ? (
            <CommandInput onSend={handleSendCommand} />
          ) : (
            <div className="border-t border-border px-4 py-3 flex items-center justify-between bg-yellow-500/5">
              <span className="text-sm text-muted-foreground">No conductor is running</span>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  await fetch(`/api/ensemble/${encodeURIComponent(ensemble)}/recruit`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: "conductor", workDir: maestroMetadata?.workDir ?? "" }),
                  });
                }}
              >
                Start Conductor
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
