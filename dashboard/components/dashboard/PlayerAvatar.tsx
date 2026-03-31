"use client";

import { cn } from "@/lib/utils";
import { getPlayerIdentity } from "@/lib/player-identity";

interface PlayerAvatarProps {
  name: string;
  size?: "sm" | "md";
}

export function PlayerAvatar({ name, size = "md" }: PlayerAvatarProps) {
  const { color, Icon } = getPlayerIdentity(name);
  const sizeClasses = size === "sm" ? "h-6 w-6" : "h-8 w-8";
  const iconSize = size === "sm" ? "h-3 w-3" : "h-4 w-4";

  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-full shrink-0 border",
        sizeClasses,
        color.bg,
        color.border
      )}
    >
      <Icon className={cn(iconSize, color.text)} />
    </div>
  );
}
