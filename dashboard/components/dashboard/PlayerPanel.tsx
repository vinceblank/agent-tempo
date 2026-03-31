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
  const realPlayers = players.filter((p) => p.metadata.playerId !== "maestro");

  return (
    <div className="flex h-full w-[300px] flex-col border-r border-border">
      <ScrollArea className="flex-1">
        {/* YOUR CHAT section */}
        <div className="px-3 pt-3 pb-2">
          <span className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Your Chat
          </span>
        </div>
        <div className="px-2 pb-2">
          <button
            onClick={onSelectEnsemble}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors",
              selectedId === null
                ? "bg-primary/15 text-primary"
                : "hover:bg-muted/50"
            )}
          >
            <PlayerAvatar name="maestro" size="sm" />
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium">Ensemble Chat</span>
              <p className="truncate text-[11px] text-muted-foreground">
                Talk to your conductor
              </p>
            </div>
          </button>
        </div>

        {/* Divider */}
        <div className="mx-3 border-t border-border" />

        {/* PLAYERS section */}
        <div className="px-3 pt-3 pb-1">
          <span className="px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Players
          </span>
        </div>
        <div className="space-y-0.5 px-2 pb-2">
          {realPlayers.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted-foreground">
              No players yet
            </p>
          ) : (
            realPlayers.map((player) => (
              <PlayerCard
                key={player.metadata.playerId}
                player={player}
                selected={selectedId === player.metadata.playerId}
                onClick={() => onSelect(player.metadata.playerId)}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
