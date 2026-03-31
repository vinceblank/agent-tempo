"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { PlayerAvatar } from "@/components/dashboard/PlayerAvatar";
import type { PlayerEntry } from "@/hooks/usePlayers";

interface PlayerCardProps {
  player: PlayerEntry;
  selected: boolean;
  onClick: () => void;
}

export function PlayerCard({ player, selected, onClick }: PlayerCardProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border border-transparent px-3 py-3 text-left transition-colors",
        selected ? "border-border bg-muted" : "hover:bg-muted/50"
      )}
    >
      <PlayerAvatar name={player.metadata.playerId} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">
            {player.metadata.playerId}
          </span>
          {player.metadata.isConductor && (
            <Badge
              variant="secondary"
              className="shrink-0 px-1.5 py-0 text-[10px]"
            >
              conductor
            </Badge>
          )}
        </div>
        {player.part && (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {player.part}
          </p>
        )}
      </div>
    </button>
  );
}
