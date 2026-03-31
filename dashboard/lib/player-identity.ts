import {
  Music,
  Guitar,
  Drum,
  Piano,
  Mic,
  Radio,
  Headphones,
  Volume2,
  Bell,
  Disc,
  Wand2,
  type LucideIcon,
} from "lucide-react";

export interface PlayerColor {
  bg: string;
  text: string;
  border: string;
}

export interface PlayerIdentity {
  color: PlayerColor;
  Icon: LucideIcon;
}

const COLORS: PlayerColor[] = [
  { bg: "bg-blue-500/15", text: "text-blue-400", border: "border-blue-500/30" },
  { bg: "bg-purple-500/15", text: "text-purple-400", border: "border-purple-500/30" },
  { bg: "bg-emerald-500/15", text: "text-emerald-400", border: "border-emerald-500/30" },
  { bg: "bg-amber-500/15", text: "text-amber-400", border: "border-amber-500/30" },
  { bg: "bg-rose-500/15", text: "text-rose-400", border: "border-rose-500/30" },
  { bg: "bg-cyan-500/15", text: "text-cyan-400", border: "border-cyan-500/30" },
  { bg: "bg-orange-500/15", text: "text-orange-400", border: "border-orange-500/30" },
  { bg: "bg-indigo-500/15", text: "text-indigo-400", border: "border-indigo-500/30" },
];

const ICONS: LucideIcon[] = [Music, Guitar, Drum, Piano, Mic, Radio, Headphones, Volume2, Bell, Disc];

const MAESTRO_IDENTITY: PlayerIdentity = {
  color: { bg: "bg-yellow-500/15", text: "text-yellow-400", border: "border-yellow-500/30" },
  Icon: Wand2,
};

const CONDUCTOR_IDENTITY: PlayerIdentity = {
  color: { bg: "bg-yellow-500/15", text: "text-yellow-400", border: "border-yellow-500/30" },
  Icon: Wand2,
};

function hashName(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function getPlayerIdentity(name: string): PlayerIdentity {
  const lower = name.toLowerCase();
  if (lower === "maestro") return MAESTRO_IDENTITY;
  if (lower.includes("conductor")) return CONDUCTOR_IDENTITY;

  const hash = hashName(name);
  return {
    color: COLORS[hash % COLORS.length],
    Icon: ICONS[hash % ICONS.length],
  };
}
