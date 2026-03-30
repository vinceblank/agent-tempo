"use client";

import { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FeedMessage } from "./FeedMessage";
import type { HistoryEntry } from "@/lib/tempo-types";

interface FeedPanelProps {
  entries: HistoryEntry[];
}

export function FeedPanel({ entries }: FeedPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(entries.length);

  useEffect(() => {
    if (entries.length > prevLengthRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevLengthRef.current = entries.length;
  }, [entries.length]);

  return (
    <ScrollArea className="flex-1 overflow-hidden">
      <div className="space-y-3 p-4">
        {entries.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            No activity yet
          </p>
        ) : (
          entries.map((entry, i) => (
            <FeedMessage key={`${entry.timestamp}-${i}`} entry={entry} />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </ScrollArea>
  );
}
