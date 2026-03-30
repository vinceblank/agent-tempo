"use client";

import Link from "next/link";
import { Terminal, Box, Moon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EnsembleSidebarProps {
  ensembles: string[];
  activeEnsemble: string;
}

export function EnsembleSidebar({
  ensembles,
  activeEnsemble,
}: EnsembleSidebarProps) {
  return (
    <div className="flex h-full w-full flex-col border-r border-border bg-sidebar">
      {/* Logo */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-4">
        <Terminal className="h-5 w-5 text-primary" />
        <span className="font-mono text-sm font-semibold text-primary">
          claude-tempo
        </span>
      </div>

      {/* Ensemble list */}
      <nav className="flex-1 overflow-y-auto p-2">
        {ensembles.map((name) => (
          <Link
            key={name}
            href={`/ensemble/${encodeURIComponent(name)}`}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
              activeEnsemble === name
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Box className="h-4 w-4" />
            <span className="truncate">{name}</span>
          </Link>
        ))}
      </nav>

      {/* Dark mode indicator */}
      <div className="border-t border-border px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Moon className="h-3.5 w-3.5" />
          <span>Dark mode</span>
        </div>
      </div>
    </div>
  );
}
