"use client";

import { useState, useCallback, useEffect, useMemo, useRef, use } from "react";
import { useRouter } from "next/navigation";
import { Check, Trash2, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { getPlayerIdentity } from "@/lib/player-identity";
import { PlayerAvatar } from "@/components/dashboard/PlayerAvatar";
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
import { usePlayerDetail } from "@/hooks/usePlayerDetail";
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
  const conductorId = conductorStatus?.conductorId ?? null;
  const [pendingMessages, setPendingMessages] = useState<SentMessage[]>([]);
  const scrollEndRef = useRef<HTMLDivElement>(null);

  // Fetch selected player's messages when a player is selected
  const { data: playerDetail } = usePlayerDetail(
    ensemble,
    selectedPlayerId ?? "__none__"
  );

  // Auto-start maestro on mount
  useEffect(() => {
    fetch(`/api/ensemble/${encodeURIComponent(ensemble)}/maestro/start`, {
      method: "POST",
    }).catch(() => {});
  }, [ensemble]);

  // Clean up pending messages once they appear in server data
  useEffect(() => {
    if (!maestroData?.sentMessages.length) return;
    setPendingMessages((prev) =>
      prev.filter(
        (pm) =>
          !maestroData.sentMessages.some(
            (sm) =>
              sm.text === pm.text &&
              Math.abs(
                new Date(sm.timestamp).getTime() -
                  new Date(pm.timestamp).getTime()
              ) < 10000
          )
      )
    );
  }, [maestroData?.sentMessages]);

  const timeline = useMemo<TimelineEntry[]>(() => {
    if (!maestroData) return [];
    const entries: TimelineEntry[] = [
      ...maestroData.messages.map(
        (m): TimelineEntry => ({ direction: "inbound", message: m })
      ),
      ...maestroData.sentMessages.map(
        (m): TimelineEntry => ({ direction: "outbound", message: m })
      ),
      ...pendingMessages
        .filter(
          (pm) =>
            !maestroData.sentMessages.some(
              (sm) =>
                sm.text === pm.text &&
                Math.abs(
                  new Date(sm.timestamp).getTime() -
                    new Date(pm.timestamp).getTime()
                ) < 10000
            )
        )
        .map((m): TimelineEntry => ({ direction: "outbound", message: m })),
    ];
    entries.sort(
      (a, b) =>
        new Date(a.message.timestamp).getTime() -
        new Date(b.message.timestamp).getTime()
    );
    return entries;
  }, [maestroData, pendingMessages]);

  // Player detail timeline (when a player is selected)
  const playerTimeline = useMemo<TimelineEntry[]>(() => {
    if (!playerDetail) return [];
    const entries: TimelineEntry[] = [
      ...playerDetail.messages.map(
        (m): TimelineEntry => ({ direction: "inbound", message: m })
      ),
      ...playerDetail.sentMessages.map(
        (m): TimelineEntry => ({ direction: "outbound", message: m })
      ),
    ];
    entries.sort(
      (a, b) =>
        new Date(a.message.timestamp).getTime() -
        new Date(b.message.timestamp).getTime()
    );
    return entries;
  }, [playerDetail]);

  // Active timeline depends on selection
  const activeTimeline = selectedPlayerId ? playerTimeline : timeline;

  const handleSendToPlayer = useCallback(
    async (message: string) => {
      if (!selectedPlayerId) return;
      await fetch(`/api/ensemble/${encodeURIComponent(ensemble)}/maestro`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: selectedPlayerId, text: message }),
      });
    },
    [ensemble, selectedPlayerId]
  );

  const handleSendCommand = useCallback(
    async (message: string) => {
      const tempMsg: SentMessage = {
        id: `pending-${Date.now()}`,
        to: conductorId!,
        text: message,
        timestamp: new Date().toISOString(),
      };
      setPendingMessages((prev) => [...prev, tempMsg]);
      await fetch(`/api/ensemble/${encodeURIComponent(ensemble)}/maestro`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: conductorId, text: message }),
      });
    },
    [ensemble, conductorId]
  );

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeTimeline]);

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
        <div className="flex items-center gap-2">
          <RecruitDialog onRecruit={handleRecruit} defaultWorkDir={maestroMetadata?.workDir} />
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
            onClick={async () => {
              if (!window.confirm(`Disband ensemble "${ensemble}"? This will terminate all players.`)) return;
              await fetch(`/api/ensemble/${encodeURIComponent(ensemble)}/disband`, {
                method: "POST",
              });
              router.push("/");
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Disband
          </Button>
        </div>
      </div>

      {/* Stats */}
      <StatsBar players={players ?? []} />

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        <PlayerPanel
          players={players ?? []}
          selectedId={selectedPlayerId}
          onSelect={(id) => setSelectedPlayerId(id)}
          onSelectEnsemble={() => setSelectedPlayerId(null)}
        />
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Chat Timeline Header */}
          {selectedPlayerId && (
            <div className="flex items-center gap-2 border-b border-border px-4 py-2">
              <button
                onClick={() => setSelectedPlayerId(null)}
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <PlayerAvatar name={selectedPlayerId} size="sm" />
              <span className="text-sm font-medium">{selectedPlayerId}</span>
            </div>
          )}

          <ScrollArea className="flex-1 overflow-hidden">
            <div className="space-y-3 p-4">
              {activeTimeline.length === 0 ? (
                <p className="py-12 text-center text-sm text-muted-foreground">
                  {selectedPlayerId ? "No messages for this player" : "No messages yet"}
                </p>
              ) : (
                activeTimeline.map((entry) => {
                  const isOutbound = entry.direction === "outbound";
                  const msg = entry.message;
                  const timestamp = new Date(msg.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  });

                  const inboundIdentity = !isOutbound
                    ? getPlayerIdentity((msg as Message).from)
                    : null;

                  return (
                    <div
                      key={msg.id}
                      className={cn("flex gap-2", isOutbound && "justify-end")}
                    >
                      {!isOutbound && (
                        <PlayerAvatar name={(msg as Message).from} size="sm" />
                      )}
                      <div className="max-w-[80%]">
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
                              <span className={cn("font-medium", inboundIdentity?.color.text)}>
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
                    </div>
                  );
                })
              )}
              <div ref={scrollEndRef} />
            </div>
          </ScrollArea>

          {selectedPlayerId ? (
            <CommandInput
              onSend={handleSendToPlayer}
              placeholder={`Send message to ${selectedPlayerId}...`}
            />
          ) : conductorActive ? (
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
                    body: JSON.stringify({ name: `${ensemble}-conductor`, workDir: maestroMetadata?.workDir ?? "", isConductor: true }),
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
