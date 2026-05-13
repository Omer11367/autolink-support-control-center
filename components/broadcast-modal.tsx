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
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [sendState, setSendState] = useState<SendState>({ status: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isImage = attachedFile ? attachedFile.type.startsWith("image/") : false;

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setAttachedFile(file);
    if (file && file.type.startsWith("image/")) {
      setImagePreview(URL.createObjectURL(file));
    } else {
      setImagePreview(null);
    }
  }

  function removeFile() {
    setAttachedFile(null);
    setImagePreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleClose() {
    if (sendState.status === "sending") return;
    setOpen(false);
    setText("");
    removeFile();
    setSendState({ status: "idle" });
  }

  async function handleSend() {
    if (!text.trim() && !attachedFile) return;
    setSendState({ status: "sending" });

    try {
      const form = new FormData();
      if (text.trim()) form.set("text", text.trim());
      if (attachedFile) form.set("file", attachedFile);

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

  const canSend = (text.trim().length > 0 || attachedFile !== null) && sendState.status !== "sending";

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

              {/* File / Photo attachment */}
              <div>
                <label className="mb-1.5 block text-xs font-medium text-zinc-400">
                  Photo or File <span className="text-zinc-600">(optional — image, PDF, doc, etc.)</span>
                </label>

                {attachedFile ? (
                  <div className="flex items-center gap-3 rounded-lg border border-border bg-zinc-950 px-4 py-3">
                    {isImage && imagePreview ? (
                      /* Image preview */
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={imagePreview} alt="Preview" className="h-12 w-12 rounded object-cover flex-shrink-0" />
                    ) : (
                      /* Generic file icon */
                      <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded bg-zinc-800 text-zinc-400">
                        <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-zinc-200">{attachedFile.name}</p>
                      <p className="text-xs text-zinc-500">{(attachedFile.size / 1024).toFixed(0)} KB · {attachedFile.type || "file"}</p>
                    </div>
                    {sendState.status !== "done" && (
                      <button
                        onClick={removeFile}
                        className="flex-shrink-0 rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-red-400"
                        title="Remove file"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
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
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" x2="12" y1="3" y2="15" />
                    </svg>
                    Click to attach a photo or file
                  </button>
                )}

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="*"
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
