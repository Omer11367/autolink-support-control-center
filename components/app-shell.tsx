"use client";

import { Bot, BookOpen, FlaskConical, Gauge, Inbox, Library, Settings } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/", label: "Dashboard", icon: Gauge },
  { href: "/tickets", label: "Tickets", icon: Inbox },
  { href: "/knowledge-base", label: "Knowledge Base", icon: BookOpen },
  { href: "/test-lab", label: "Bot Test Lab", icon: FlaskConical },
  { href: "/intents", label: "Intent Library", icon: Library },
  { href: "/settings", label: "Settings", icon: Settings }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [timestamp, setTimestamp] = useState("");

  useEffect(() => {
    setTimestamp(new Intl.DateTimeFormat("en", {
      dateStyle: "medium",
      timeStyle: "short"
    }).format(new Date()));
  }, []);

  return (
    <div className="min-h-screen bg-background md:grid md:grid-cols-[280px_1fr]">
      <aside className="border-b border-border bg-card/95 md:min-h-screen md:border-b-0 md:border-r">
        <div className="px-5 py-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-panel">
              <Bot className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <div className="text-sm font-bold">Autolink</div>
              <div className="text-xs text-muted-foreground">Support Control Center</div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-success/30 bg-success/10 px-2 py-1 font-semibold text-emerald-700 dark:text-emerald-200">Production</span>
            <span className="rounded-full border border-border bg-muted px-2 py-1 font-semibold text-muted-foreground">Vercel</span>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:block md:space-y-1 md:overflow-visible">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex min-h-11 shrink-0 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                  active ? "bg-primary text-primary-foreground shadow-panel" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="hidden px-5 py-4 text-xs text-muted-foreground md:block">
          <p className="font-semibold text-foreground">Local time</p>
          <p className="mt-1">{timestamp || "Loading..."}</p>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-[1500px]">{children}</div>
      </main>
    </div>
  );
}
