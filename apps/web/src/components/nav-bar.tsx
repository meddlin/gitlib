import { Link } from "@tanstack/react-router";
import { GitBranch, Settings } from "lucide-react";
import { cn } from "#/lib/utils";

const LINKS = [
  { to: "/", label: "Repositories", icon: GitBranch },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function NavBar() {
  return (
    <nav aria-label="Main" className="sticky top-0 z-20 h-12 shrink-0 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-full max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link to="/" className="text-sm font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Gitlib
        </Link>
        <ul className="flex items-center gap-1">
          {LINKS.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <Link
                to={to}
                activeOptions={{ exact: true }}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
                )}
                activeProps={{ className: "bg-accent text-accent-foreground font-medium", "aria-current": "page" }}
              >
                <Icon className="size-3.5" aria-hidden />
                {label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
