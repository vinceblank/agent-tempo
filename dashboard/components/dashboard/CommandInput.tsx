"use client";

import { useState, useCallback } from "react";
import { Send } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

interface CommandInputProps {
  onSend: (message: string) => Promise<void>;
}

export function CommandInput({ onSend }: CommandInputProps) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || sending) return;

    setSending(true);
    try {
      await onSend(trimmed);
      setValue("");
    } finally {
      setSending(false);
    }
  }, [value, sending, onSend]);

  return (
    <div>
      <Separator />
      <div className="flex items-center gap-2 p-3">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder="Send a command..."
          disabled={sending}
          className="flex-1"
        />
        <Button
          size="icon"
          onClick={handleSubmit}
          disabled={sending || !value.trim()}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
