import { Link } from "@tanstack/react-router";
import { FolderKanban, GitBranch, GitPullRequest, ListTodo, MessageSquare, Settings } from "lucide-react";
import { BUCKET_LABELS, BUCKET_ORDER } from "#/lib/dependabot";
import { useLibraryState } from "#/lib/library-state";
import { useDependabotBadge } from "#/lib/use-dependabot-badge";
import { cn } from "#/lib/utils";

const LINKS = [
  { to: "/", label: "Repositories", icon: GitBranch },
  { to: "/projects", label: "Projects", icon: FolderKanban },
  { to: "/planning", label: "Planning", icon: ListTodo },
  { to: "/dependabot", label: "Dependabot", icon: GitPullRequest },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function NavBar({ chatOpen, onToggleChat }: { chatOpen: boolean; onToggleChat: () => void }) {
  // Links back to Repositories bring the table's filters and sort with them.
  const library = useLibraryState();
  const dependabot = useDependabotBadge();
  return (
    <nav aria-label="Main" className="sticky top-0 z-20 h-12 min-w-0 shrink-0 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-full max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Link to="/" search={library} className="shrink-0 text-sm font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Gitlib
        </Link>
        {/* On a phone the links scroll sideways rather than push the Ask button off screen. */}
        <ul className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none]">
          {LINKS.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <Link
                to={to}
                search={to === "/" ? library : undefined}
                // "/" matches every URL, so only it must be exact; Planning stays active on an issue's page.
                activeOptions={{ exact: to === "/", includeSearch: false }}
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
                )}
                activeProps={{ className: "bg-accent text-accent-foreground font-medium", "aria-current": "page" }}
              >
                {/* Five labelled links don't fit a phone's width with their icons. */}
                <Icon className="size-3.5 max-sm:hidden" aria-hidden />
                {label}
                {to === "/dependabot" && dependabot && dependabot.actionable > 0 ? (
                  <span
                    className="rounded-full bg-primary px-1.5 text-[0.7rem] font-medium leading-5 text-primary-foreground"
                    title={BUCKET_ORDER.filter((bucket) => dependabot.counts[bucket] > 0)
                      .map((bucket) => `${dependabot.counts[bucket]} ${BUCKET_LABELS[bucket].toLowerCase()}`)
                      .join(", ")}
                  >
                    <span className="sr-only">{dependabot.actionable} pull requests to look at: </span>
                    {dependabot.actionable}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
        <button
          type="button"
          aria-pressed={chatOpen}
          onClick={onToggleChat}
          className={cn(
            "ml-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring",
            chatOpen && "bg-accent font-medium text-accent-foreground",
          )}
        >
          <MessageSquare className="size-3.5" aria-hidden />
          Ask
        </button>
      </div>
    </nav>
  );
}
