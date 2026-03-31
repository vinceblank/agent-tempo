"use client";

import { use, useState, useCallback, useMemo } from "react";
import { ArrowLeft, GitBranch, FolderOpen, Monitor, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { CommandInput } from "@/components/dashboard/CommandInput";
import { usePlayerDetail } from "@/hooks/usePlayerDetail";
import { useConductorStatus } from "@/hooks/useConductorStatus";
import type { Message, SentMessage } from "@/lib/tempo-types";

type TimelineEntry =
  | { direction: "inbound"; message: Message }
  | { direction: "outbound"; message: SentMessage };

export default function PlayerDetailPage({
  params,
}: {
  params: Promise<{ ensemble: string; playerId: string }>;
}) {
  const { ensemble, playerId } = use(params);
  const { data: detail, loading } = usePlayerDetail(ensemble, playerId);
  const { data: conductorStatus } = useConductorStatus(ensemble);
  const conductorActive = conductorStatus?.active ?? false;

  const timeline = useMemo<TimelineEntry[]>(() => {
    if (!detail) return [];
    const entries: TimelineEntry[] = [
      ...detail.messages.map(
        (m): TimelineEntry => ({ direction: "inbound", message: m })
      ),
      ...detail.sentMessages.map(
        (m): TimelineEntry => ({ direction: "outbound", message: m })
      ),
    ];
    entries.sort(
      (a, b) =>
        new Date(a.message.timestamp).getTime() -
        new Date(b.message.timestamp).getTime()
    );
    return entries;
  }, [detail]);

  const handleSendMessage = useCallback(
    async (message: string) => {
      await fetch(
        `/api/ensemble/${encodeURIComponent(ensemble)}/maestro`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target: playerId, text: message }),
        }
      );
    },
    [ensemble, playerId]
  );

  if (loading && !detail) {
    return (
      <div className="flex flex-1 flex-col gap-4 p-6">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Link
          href={`/ensemble/${encodeURIComponent(ensemble)}`}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-lg font-semibold">{playerId}</h1>
        {detail?.metadata.isConductor && (
          <Badge variant="secondary" className="text-xs">
            conductor
          </Badge>
        )}
      </div>

      {/* Metadata */}
      {detail && (
        <div className="border-b border-border px-4 py-3">
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <FolderOpen className="h-3 w-3" />
              <span className="font-mono">{detail.metadata.workDir}</span>
            </div>
            {detail.metadata.gitBranch && (
              <div className="flex items-center gap-1.5">
                <GitBranch className="h-3 w-3" />
                <span className="font-mono">{detail.metadata.gitBranch}</span>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <Monitor className="h-3 w-3" />
              <span className="font-mono">{detail.metadata.hostname}</span>
            </div>
          </div>
          {detail.part && (
            <p className="mt-2 text-sm text-muted-foreground">{detail.part}</p>
          )}
        </div>
      )}

      {/* Messages Timeline */}
      <ScrollArea className="flex-1 overflow-hidden">
        <div className="space-y-3 p-4">
          {timeline.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No messages
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

      <Separator />
      <CommandInput
        onSend={handleSendMessage}
        disabled={!conductorActive}
        placeholder={conductorActive ? undefined : "Conductor required to send messages"}
      />
    </div>
  );
}
