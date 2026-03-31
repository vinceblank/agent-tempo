"use client";

import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PlayerAvatar } from "./PlayerAvatar";
import { PlayerCard } from "./PlayerCard";
import type { PlayerEntry } from "@/hooks/usePlayers";

interface PlayerPanelProps {
  players: PlayerEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onSelectEnsemble: () => void;
}

export function PlayerPanel({
  players,
  selectedId,
  onSelect,
  onSelectEnsemble,
}: PlayerPanelProps) {
  return (
    <div className="flex h-full w-[300px] flex-col border-r border-border">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Players</h2>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {/* Ensemble chat entry */}
          <button
            onClick={onSelectEnsemble}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg border border-transparent px-3 py-3 text-left transition-colors",
              selectedId === null
                ? "border-border bg-muted"
                : "hover:bg-muted/50"
            )}
          >
            <PlayerAvatar name="maestro" size="sm" />
            <span className="text-sm font-medium">Ensemble Chat</span>
          </button>

          {players.filter((p) => p.metadata.playerId !== 'maestro').map((player) => (
            <PlayerCard
              key={player.metadata.playerId}
              player={player}
              selected={selectedId === player.metadata.playerId}
              onClick={() => onSelect(player.metadata.playerId)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
