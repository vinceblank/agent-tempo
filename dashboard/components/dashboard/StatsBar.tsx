"use client";

import { Users } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import type { PlayerEntry } from "@/hooks/usePlayers";

interface StatsBarProps {
  players: PlayerEntry[];
}

export function StatsBar({ players }: StatsBarProps) {
  const total = players.length;
  const active = players.filter((p) => !p.metadata.isConductor).length;

  return (
    <div className="flex items-center gap-4 border-b border-border px-4 py-2">
      <div className="flex items-center gap-2">
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-mono text-sm">{total}</span>
        <span className="text-xs text-muted-foreground">Total</span>
      </div>

      <Separator orientation="vertical" className="h-4" />

      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-success" />
        <span className="font-mono text-sm">{active}</span>
        <span className="text-xs text-muted-foreground">Active</span>
      </div>

      <Separator orientation="vertical" className="h-4" />

      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-warning" />
        <span className="font-mono text-sm">0</span>
        <span className="text-xs text-muted-foreground">Idle</span>
      </div>
    </div>
  );
}
