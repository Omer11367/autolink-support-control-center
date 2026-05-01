import Link from "next/link";
import { Bot, BookOpen, FlaskConical, Gauge, Inbox, Library, Settings } from "lucide-react";

const navItems = [
  { href: "/", label: "Dashboard", icon: Gauge },
  { href: "/tickets", label: "Tickets", icon: Inbox },
  { href: "/knowledge-base", label: "Knowledge Base", icon: BookOpen },
  { href: "/test-lab", label: "Bot Test Lab", icon: FlaskConical },
  { href: "/intents", label: "Intent Library", icon: Library },
  { href: "/settings", label: "Settings", icon: Settings }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen md:grid md:grid-cols-[260px_1fr]">
      <aside className="border-b border-border bg-card md:min-h-screen md:border-b-0 md:border-r">
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Bot className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <div className="text-sm font-bold">Autolink</div>
            <div className="text-xs text-muted-foreground">Support Control Center</div>
          </div>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:block md:space-y-1 md:overflow-visible">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className="flex min-h-10 shrink-0 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>
      <main className="min-w-0 px-4 py-5 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
