import { useMemo } from "react";
import { cn } from "#/lib/utils";
import type { ContributionSource, ContributionsView } from "#/server/contributions";
export type { ContributionSource };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAY_LABELS: Record<number, string> = { 1: "Mon", 3: "Wed", 5: "Fri" };

/** Five shades, empty to busiest. */
const LEVELS = ["bg-muted", "bg-emerald-900/40", "bg-emerald-700/70", "bg-emerald-600", "bg-emerald-400"];

const dayKey = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

interface Cell {
  key: string;
  date: Date;
  count: number;
}

/** Weeks (Sunday first) ending with the current one, covering roughly the last year. */
function buildWeeks(days: Record<string, number>): Cell[][] {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - 52 * 7 - today.getDay());
  const weeks: Cell[][] = [];
  for (const cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
    if (cursor.getDay() === 0) weeks.push([]);
    const key = dayKey(cursor);
    weeks[weeks.length - 1]!.push({
      key,
      date: new Date(cursor),
      count: days[key] ?? 0,
    });
  }
  return weeks;
}

/** GitHub-style quartiles of the non-zero days, so one busy day doesn't wash out the rest. */
function levelFn(days: Record<string, number>): (count: number) => number {
  const counts = Object.values(days).sort((a, b) => a - b);
  const at = (q: number) => counts[Math.min(counts.length - 1, Math.floor(counts.length * q))] ?? 1;
  const [q1, q2, q3] = [at(0.25), at(0.5), at(0.75)];
  return (count) => (count === 0 ? 0 : count <= q1 ? 1 : count <= q2 ? 2 : count <= q3 ? 3 : 4);
}

const formatDay = (date: Date) =>
  date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });

const SOURCES: { id: ContributionSource; label: string }[] = [
  { id: "local", label: "Local" },
  { id: "all", label: "Local + GitHub & GitLab" },
];

export function ContributionGraph({
  data,
  loading,
  source,
  onSourceChange,
}: {
  data: ContributionsView | undefined;
  loading: boolean;
  source: ContributionSource;
  onSourceChange: (source: ContributionSource) => void;
}) {
  const weeks = useMemo(() => buildWeeks(data?.days ?? {}), [data]);
  const level = useMemo(() => levelFn(data?.days ?? {}), [data]);

  // Label a month above the first week that starts in it, skipping labels that would collide.
  const monthLabels = useMemo(() => {
    const labels: (string | null)[] = [];
    let last = -1;
    let lastAt = -3;
    weeks.forEach((week, index) => {
      const month = week[0]!.date.getMonth();
      if (month !== last && index - lastAt >= 3) {
        labels.push(MONTHS[month]!);
        lastAt = index;
      } else labels.push(null);
      last = month;
    });
    return labels;
  }, [weeks]);

  return (
    <section aria-label="Contribution graph" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          {data ? (
            <>
              {data.total.toLocaleString()} {data.total === 1 ? "commit" : "commits"} in the last year
              <span className="font-normal text-muted-foreground">
                {" "}
                {source === "local"
                  ? ` across ${data.repoCount} ${data.repoCount === 1 ? "local repository" : "local repositories"}`
                  : " from local repos, GitHub and GitLab"}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Loading commit activity…</span>
          )}
        </h2>
        <div role="radiogroup" aria-label="Contribution sources" className="flex border text-xs">
          {SOURCES.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={source === option.id}
              onClick={() => onSourceChange(option.id)}
              className={cn(
                "px-2.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                source === option.id
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {source === "all" &&
        data?.notices.map((notice) => (
          <p key={notice} className="text-xs text-muted-foreground" role="status">
            {notice}
          </p>
        ))}
      <div className="overflow-x-auto border p-3">
        <div className="mx-auto flex w-max gap-1.5 text-[10px] text-muted-foreground">
          <div className="grid grid-rows-[auto_repeat(7,0.75rem)] gap-[3px] pr-1">
            <span aria-hidden className="h-3" />
            {Array.from({ length: 7 }, (_, row) => (
              <span key={row} className="flex items-center leading-none">
                {WEEKDAY_LABELS[row] ?? ""}
              </span>
            ))}
          </div>
          <div className={cn("flex gap-[3px]", loading && "animate-pulse")}>
            {weeks.map((week, index) => (
              <div key={week[0]!.key} className="grid grid-rows-[auto_repeat(7,0.75rem)] gap-[3px]">
                <span className="relative h-3 leading-none">
                  <span className="absolute left-0 whitespace-nowrap">{monthLabels[index]}</span>
                </span>
                {week.map((cell) => (
                  <span
                    key={cell.key}
                    title={`${cell.count} ${cell.count === 1 ? "commit" : "commits"} on ${formatDay(cell.date)}`}
                    className={cn("size-3 rounded-[2px]", LEVELS[level(cell.count)])}
                    style={{ gridRowStart: cell.date.getDay() + 2 }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
          Less
          {LEVELS.map((cls) => (
            <span key={cls} className={cn("size-3 rounded-[2px]", cls)} />
          ))}
          More
        </div>
      </div>
    </section>
  );
}
