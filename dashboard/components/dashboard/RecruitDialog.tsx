"use client";

import { useState, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { UserPlus } from "lucide-react";

interface RecruitDialogProps {
  onRecruit: (data: {
    name: string;
    workDir: string;
    initialMessage?: string;
  }) => Promise<void>;
}

export function RecruitDialog({ onRecruit }: RecruitDialogProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [workDir, setWorkDir] = useState("");
  const [initialMessage, setInitialMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!name.trim() || !workDir.trim() || submitting) return;

    setSubmitting(true);
    try {
      await onRecruit({
        name: name.trim(),
        workDir: workDir.trim(),
        initialMessage: initialMessage.trim() || undefined,
      });
      setName("");
      setWorkDir("");
      setInitialMessage("");
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  }, [name, workDir, initialMessage, submitting, onRecruit]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline" className="gap-1.5">
            <UserPlus className="h-3.5 w-3.5" />
            Recruit
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Recruit a new player</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <div className="space-y-2">
            <label htmlFor="recruit-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="recruit-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. test-runner"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="recruit-workdir" className="text-sm font-medium">
              Working Directory
            </label>
            <Input
              id="recruit-workdir"
              value={workDir}
              onChange={(e) => setWorkDir(e.target.value)}
              placeholder="e.g. C:\repos\my-project"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="recruit-message" className="text-sm font-medium">
              Initial Message <span className="text-muted-foreground">(optional)</span>
            </label>
            <Input
              id="recruit-message"
              value={initialMessage}
              onChange={(e) => setInitialMessage(e.target.value)}
              placeholder="What should this player do?"
            />
          </div>
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || !workDir.trim() || submitting}
            className="w-full"
          >
            {submitting ? "Recruiting..." : "Recruit Player"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
