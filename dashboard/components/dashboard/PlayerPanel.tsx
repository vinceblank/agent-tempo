"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { PlayerCard } from "./PlayerCard";
import type { PlayerEntry } from "@/hooks/usePlayers";

interface PlayerPanelProps {
  players: PlayerEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function PlayerPanel({
  players,
  selectedId,
  onSelect,
}: PlayerPanelProps) {
  return (
    <div className="flex h-full w-[300px] flex-col border-r border-border">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Players</h2>
      </div>
      <ScrollArea className="flex-1">
        <div className="space-y-1 p-2">
          {players.map((player) => (
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
