"use client";

import { useRef, useState } from "react";
import { Button, SecondaryButton, Textarea } from "@/components/ui";

type SendState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "done"; sent: number; failed: number; total: number }
  | { status: "error"; message: string };

export function BroadcastModal() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [sendState, setSendState] = useState<SendState>({ status: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setPhotoFile(file);
    if (file) {
      const url = URL.createObjectURL(file);
      setPhotoPreview(url);
    } else {
      setPhotoPreview(null);
    }
  }

  function removePhoto() {
    setPhotoFile(null);
    setPhotoPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleClose() {
    if (sendState.status === "sending") return;
    setOpen(false);
    setText("");
    removePhoto();
    setSendState({ status: "idle" });
  }

  async function handleSend() {
    if (!text.trim() && !photoFile) return;
    setSendState({ status: "sending" });

    try {
      const form = new FormData();
      if (text.trim()) form.set("text", text.trim());
      if (photoFile) form.set("photo", photoFile);

      const res = await fetch("/api/broadcast", { method: "POST", body: form });
      const data = (await res.json()) as { sent?: number; failed?: number; total?: number; error?: string };

      if (!res.ok || data.error) {
        setSendState({ status: "error", message: data.error ?? "Broadcast failed." });
        return;
      }

      setSendState({ status: "done", sent: data.sent ?? 0, failed: data.failed ?? 0, total: data.total ?? 0 });
    } catch (err) {
      setSendState({ status: "error", message: err instanceof Error ? err.message : "Network error." });
    }
  }

  const canSend = (text.trim().length > 0 || photoFile !== null) && sendState.status !== "sending";

  return (
    <>
      {/* Trigger button */}
      <Button
        type="button"
        onClick={() => setOpen(true)}
        className="gap-2"
        title="Send a message to all client groups"
      >
        {/* Megaphone icon (inline SVG so no extra dep needed) */}
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m3 11 18-5v12L3 14v-3z" />
          <path d="M11.6 16.8a3 3 0 1 1-5.8-1.6" />
        </svg>
        Broadcast
      </Button>

      {/* Modal overlay */}
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
        >
          <div className="w-full max-w-lg rounded-xl border border-border bg-zinc-900 shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <div>
                <h2 className="text-base font-semibold text-foreground">Broadcast to All Clients</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">Sent instantly to every connected client group</p>
              </div>
              <button
                onClick={handleClose}
                className="rounded-md p-1 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
                aria-label="Close"
                disabled={sendState.status === "sending"}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="space-y-4 p-5">
              {/* Message textarea */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                  Message <span className="text-zinc-600">(optional if sending a photo)</span>
                </label>
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Type your message here… supports links and basic HTML formatting"
                  className="min-h-32 resize-none"
                  disabled={sendState.status === "sending" || sendState.status === "done"}
                />
              </div>

              {/* Photo attachment */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                  Photo <span className="text-zinc-600">(optional)</span>
                </label>

                {photoPreview ? (
                  <div className="relative inline-block">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={photoPreview}
                      alt="Attached photo"
                      className="max-h-48 rounded-lg border border-border object-contain"
                    />
                    {sendState.status !== "done" && (
                      <button
                        onClick={removePhoto}
                        className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-zinc-800 border border-border text-zinc-400 hover:bg-red-900 hover:text-red-300 transition"
                        title="Remove photo"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={sendState.status === "sending" || sendState.status === "done"}
                    className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-700 bg-zinc-950 px-4 py-5 text-sm text-zinc-500 transition hover:border-zinc-500 hover:text-zinc-300 disabled:pointer-events-none disabled:opacity-50"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
                      <circle cx="9" cy="9" r="2" />
                      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
                    </svg>
                    Click to attach a photo
                  </button>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </div>

              {/* Status feedback */}
              {sendState.status === "done" && (
                <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 text-sm">
                  <p className="font-semibold text-emerald-400">
                    ✓ Sent to {sendState.sent} of {sendState.total} group{sendState.total !== 1 ? "s" : ""}
                  </p>
                  {sendState.failed > 0 && (
                    <p className="mt-0.5 text-xs text-emerald-600">{sendState.failed} group{sendState.failed !== 1 ? "s" : ""} could not be reached.</p>
                  )}
                </div>
              )}

              {sendState.status === "error" && (
                <div className="rounded-lg border border-red-800 bg-red-950/40 px-4 py-3 text-sm text-red-400">
                  {sendState.message}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
              {sendState.status === "done" ? (
                <Button onClick={handleClose}>Close</Button>
              ) : (
                <>
                  <SecondaryButton onClick={handleClose} disabled={sendState.status === "sending"}>
                    Cancel
                  </SecondaryButton>
                  <Button onClick={handleSend} disabled={!canSend}>
                    {sendState.status === "sending" ? (
                      <>
                        <svg className="animate-spin" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                        </svg>
                        Sending…
                      </>
                    ) : (
                      <>
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="m22 2-7 20-4-9-9-4Z" />
                          <path d="M22 2 11 13" />
                        </svg>
                        Send to All Clients
                      </>
                    )}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
