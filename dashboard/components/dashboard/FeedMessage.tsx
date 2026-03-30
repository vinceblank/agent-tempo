"use client";

import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type {
  HistoryEntry,
  Command,
  PlayerReport,
} from "@/lib/tempo-types";

interface FeedMessageProps {
  entry: HistoryEntry;
}

function FeedMessageInner({ entry }: FeedMessageProps) {
  const isCommand = entry.type === "command";
  const time = new Date(entry.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const command = isCommand ? (entry.data as Command) : null;
  const report = !isCommand ? (entry.data as PlayerReport) : null;

  return (
    <div
      className={cn(
        "flex max-w-[80%] flex-col gap-1",
        isCommand ? "ml-auto items-end" : "items-start"
      )}
    >
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="font-medium">
          {command?.source ?? report?.playerId}
        </span>
        {command?.replyTo && (
          <>
            <span>&rarr;</span>
            <span>{command.replyTo}</span>
          </>
        )}
        <span>{time}</span>
      </div>
      <div
        className={cn(
          "rounded-lg px-3 py-2 text-sm",
          isCommand ? "bg-primary/15 text-primary" : "bg-muted text-foreground"
        )}
      >
        <p className="whitespace-pre-wrap break-words">
          {command?.text ?? report?.text}
        </p>
        {report?.type && (
          <Badge
            variant="outline"
            className={cn(
              "mt-1.5 text-[10px]",
              report.type === "blocker" &&
                "border-destructive/50 text-destructive",
              report.type === "question" &&
                "border-warning/50 text-warning",
              report.type === "result" && "border-success/50 text-success"
            )}
          >
            {report.type}
          </Badge>
        )}
      </div>
    </div>
  );
}

export const FeedMessage = memo(FeedMessageInner);
