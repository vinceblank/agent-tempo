"use client";

import { Users } from "lucide-react";
import type { PlayerEntry } from "@/hooks/usePlayers";

interface StatsBarProps {
  players: PlayerEntry[];
}

export function StatsBar({ players }: StatsBarProps) {
  const total = players.filter((p) => p.metadata.playerId !== 'maestro').length;

  return (
    <div className="flex items-center gap-4 border-b border-border px-4 py-2">
      <div className="flex items-center gap-2">
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono text-sm">{total}</span>
        <span className="text-xs text-muted-foreground">Players</span>
      </div>
    </div>
  );
}
