"use client";

import { useRouter } from "next/navigation";
import { useState, useCallback } from "react";
import { Terminal, Plus, Box, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useEnsembles } from "@/hooks/useEnsembles";

export default function Home() {
  const router = useRouter();
  const { data, loading } = useEnsembles();
  const ensembles = data?.ensembles ?? [];
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [workDir, setWorkDir] = useState("");
  const [creating, setCreating] = useState(false);

  const handleCreate = useCallback(async () => {
    if (!name.trim() || !workDir.trim() || creating) return;
    setCreating(true);
    try {
      await fetch(`/api/ensemble/${encodeURIComponent(name.trim())}/maestro/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workDir: workDir.trim() }),
      });
      setOpen(false);
      router.push(`/ensemble/${encodeURIComponent(name.trim())}`);
    } finally {
      setCreating(false);
    }
  }, [name, workDir, creating, router]);

  return (
    <div className="flex h-full items-center justify-center bg-background">
      <div className="w-full max-w-md space-y-8 px-4">
        <div className="flex flex-col items-center gap-3">
          <Terminal className="h-10 w-10 text-primary" />
          <h1 className="font-mono text-2xl font-bold text-foreground">claude-tempo</h1>
          <p className="text-sm text-muted-foreground">Select an ensemble or create a new one</p>
        </div>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : ensembles.length > 0 ? (
          <div className="space-y-2">
            {ensembles.map((name) => (
              <button
                key={name}
                onClick={() => router.push(`/ensemble/${encodeURIComponent(name)}`)}
                className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-muted"
              >
                <Box className="h-4 w-4 text-muted-foreground" />
                <span className="font-mono text-sm">{name}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No ensembles running
          </p>
        )}

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={
            <Button variant="outline" className="w-full gap-2">
              <Plus className="h-4 w-4" />
              New Ensemble
            </Button>
          } />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create a new ensemble</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 pt-2">
              <div className="space-y-2">
                <label htmlFor="ensemble-name" className="text-sm font-medium">Ensemble Name</label>
                <Input
                  id="ensemble-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. my-project"
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="ensemble-workdir" className="text-sm font-medium">Default Working Directory</label>
                <Input
                  id="ensemble-workdir"
                  value={workDir}
                  onChange={(e) => setWorkDir(e.target.value)}
                  placeholder="e.g. C:\repos\my-project"
                />
              </div>
              <Button onClick={handleCreate} disabled={!name.trim() || !workDir.trim() || creating} className="w-full">
                {creating ? "Creating..." : "Create Ensemble"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
