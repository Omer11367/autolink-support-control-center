"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { StatusBadge } from "@/components/status-badge";
import { formatIntentLabel } from "@/lib/display";
import { getEscalationState, getTicketTimerLabel } from "@/lib/operations";
import type { Ticket } from "@/lib/types";
import { formatDate, truncate } from "@/lib/utils";

export function TicketsTable({ tickets }: { tickets: Ticket[] }) {
  const router = useRouter();

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1120px] text-left text-sm">
        <thead className="sticky top-0 z-10 border-b border-border bg-card text-xs uppercase text-muted-foreground">
          <tr>
            <th className="px-4 py-3">Ticket</th>
            <th className="px-4 py-3">Client</th>
            <th className="px-4 py-3">Intent</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">SLA</th>
            <th className="px-4 py-3">Timer</th>
            <th className="px-4 py-3">Created</th>
            <th className="px-4 py-3">Message</th>
            <th className="px-4 py-3">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {tickets.map((ticket) => {
            const sla = getEscalationState(ticket);
            const ticketCode = ticket.ticket_code ?? ticket.id.slice(0, 8);

            return (
              <tr
                key={ticket.id}
                onClick={() => router.push(`/tickets/${ticket.id}`)}
                className={`cursor-pointer transition hover:bg-muted/70 ${
                  sla === "urgent" ? "bg-danger/10" : sla === "needs_attention" ? "bg-warning/10" : ""
                }`}
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Link className="font-semibold text-foreground hover:text-primary" href={`/tickets/${ticket.id}`} onClick={(event) => event.stopPropagation()}>
                      {ticketCode}
                    </Link>
                    <CopyButton value={ticketCode} label="Code" />
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span>{ticket.client_username ?? "Unknown"}</span>
                    {ticket.client_username ? <CopyButton value={ticket.client_username} label="User" /> : null}
                  </div>
                </td>
                <td className="px-4 py-3">{formatIntentLabel(ticket.intent)}</td>
                <td className="px-4 py-3"><StatusBadge value={ticket.status} /></td>
                <td className="px-4 py-3">
                  {sla === "urgent" ? (
                    <StatusBadge value="urgent" type="priority" label="Urgent" />
                  ) : sla === "needs_attention" ? (
                    <StatusBadge value="waiting_for_mark" label="Needs attention" />
                  ) : (
                    <StatusBadge value="normal" type="neutral" label="OK" />
                  )}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{getTicketTimerLabel(ticket)}</td>
                <td className="px-4 py-3 text-muted-foreground">{formatDate(ticket.created_at)}</td>
                <td className="max-w-sm px-4 py-3 text-muted-foreground">
                  <span className="block truncate">{truncate(ticket.client_original_message, 130)}</span>
                </td>
                <td className="px-4 py-3">
                  <Link className="font-semibold text-primary hover:underline" href={`/tickets/${ticket.id}`} onClick={(event) => event.stopPropagation()}>
                    Open
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
