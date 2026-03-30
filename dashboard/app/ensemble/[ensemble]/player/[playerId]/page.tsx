"use client";

import { use, useState, useCallback } from "react";
import { ArrowLeft, GitBranch, FolderOpen, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { CommandInput } from "@/components/dashboard/CommandInput";
import { usePlayerDetail } from "@/hooks/usePlayerDetail";

export default function PlayerDetailPage({
  params,
}: {
  params: Promise<{ ensemble: string; playerId: string }>;
}) {
  const { ensemble, playerId } = use(params);
  const { data: detail, loading } = usePlayerDetail(ensemble, playerId);

  const handleSendMessage = useCallback(
    async (message: string) => {
      await fetch(
        `/api/ensemble/${encodeURIComponent(ensemble)}/player/${encodeURIComponent(playerId)}/message`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: "dashboard", text: message }),
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

      {/* Messages */}
      <ScrollArea className="flex-1 overflow-hidden">
        <div className="space-y-3 p-4">
          {detail?.messages.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No messages
            </p>
          ) : (
            detail?.messages.map((msg) => (
              <div key={msg.id} className="max-w-[80%]">
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="font-medium">{msg.from}</span>
                  <span>
                    {new Date(msg.timestamp).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  {!msg.delivered && (
                    <Badge
                      variant="outline"
                      className="text-[10px] border-warning/50 text-warning"
                    >
                      pending
                    </Badge>
                  )}
                </div>
                <div className={cn(
                  "mt-1 rounded-lg px-3 py-2 text-sm",
                  msg.delivered ? "bg-muted" : "bg-muted border border-warning/30"
                )}>
                  <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      <Separator />
      <CommandInput onSend={handleSendMessage} />
    </div>
  );
}
