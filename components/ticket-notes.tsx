"use client";

import { StickyNote } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Textarea } from "@/components/ui";
import { formatDate } from "@/lib/utils";
import type { TicketNote } from "@/lib/types";

export function TicketNotes({ ticketId, notes }: { ticketId: string; notes: TicketNote[] }) {
  const router = useRouter();
  const [noteText, setNoteText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function addNote() {
    setMessage(null);
    setError(null);

    startTransition(async () => {
      const response = await fetch(`/api/tickets/${ticketId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ noteText })
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "Could not add note.");
        return;
      }

      setNoteText("");
      setMessage("Note added.");
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        {notes.length === 0 ? (
          <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">No internal notes yet.</p>
        ) : (
          notes.map((note) => (
            <div key={note.id} className="rounded-md border border-border bg-muted p-3 text-sm">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 font-semibold">
                  <StickyNote className="h-4 w-4" aria-hidden="true" />
                  Internal note
                </div>
                <span className="text-xs text-muted-foreground">{formatDate(note.created_at)}</span>
              </div>
              <p className="whitespace-pre-wrap text-muted-foreground">{note.note_text}</p>
            </div>
          ))
        )}
      </div>

      <div className="space-y-2">
        <Textarea
          value={noteText}
          onChange={(event) => setNoteText(event.target.value)}
          placeholder="Add internal admin note..."
        />
        <Button onClick={addNote} disabled={isPending || !noteText.trim()}>
          Add note
        </Button>
      </div>

      {message ? <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-200">{message}</p> : null}
      {error ? <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">{error}</p> : null}
    </div>
  );
}
