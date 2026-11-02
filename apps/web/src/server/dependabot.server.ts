import {
  BUCKETS,
  explanationFingerprint,
  isGitLibError,
  nextSlot,
  pendingFindings,
  splitDismissed,
  type Bucket,
  type DependabotExplainer,
  type DependabotScheduler,
  type GitLibApp,
  type StoredReport,
} from "@gitlib/core";
import type { DependabotBadge, DependabotView } from "./dependabot";
import { getApp } from "./gitlib.server";

interface BackgroundHolder {
  scheduler?: DependabotScheduler;
  explainer?: DependabotExplainer;
}

// Kept on globalThis so dev-server module reloads reuse one scheduler and explainer instead of starting more timers.
const holder = ((globalThis as { __gitlibDependabot?: BackgroundHolder }).__gitlibDependabot ??= {});

/**
 * Starts what runs without anyone looking, once per server: the scheduler that checks GitHub on the user's schedule,
 * and the writer of the plain-language notes. The production server calls this at boot (see
 * `routes/api.dependabot.start.ts`); in development it starts with the first page that asks for Dependabot data.
 */
export function ensureBackground(app: GitLibApp = getApp()): { scheduler: DependabotScheduler; explainer: DependabotExplainer } {
  holder.scheduler ??= app.createDependabotScheduler();
  holder.explainer ??= app.createDependabotExplainer();
  holder.scheduler.start();
  holder.explainer.start();
  return { scheduler: holder.scheduler, explainer: holder.explainer };
}

/** Stops the scheduler and the note writer, so that the next `ensureBackground` starts fresh. */
export function stopBackground(): void {
  holder.scheduler?.stop();
  holder.explainer?.stop();
  holder.scheduler = undefined;
  holder.explainer = undefined;
}

function withoutItems(report: StoredReport): Omit<StoredReport, "items"> {
  const { items, ...rest } = report;
  void items;
  return rest;
}

const emptyCounts = (): Record<Bucket, number> => ({ ready: 0, "review-first": 0, "needs-work": 0, waiting: 0 });

/** The newest saved check with dismissed and snoozed pull requests set apart; reads gitlib's database, not GitHub. */
export function buildView(
  now: Date = new Date(),
  app: GitLibApp = getApp(),
  scheduler: DependabotScheduler | null = holder.scheduler ?? null,
  explainer: DependabotExplainer | null = holder.explainer ?? null,
): DependabotView {
  const run = app.latestDependabotRun();
  const lease = app.dependabotStore.currentLease(now);
  const { active, dismissed } = splitDismissed(run?.report.items ?? [], app.listDependabotDismissals(), now);

  const counts = emptyCounts();
  for (const item of active) counts[item.bucket] += 1;

  // A note is shown only while the facts it was written from still hold; an older one waits to be written again.
  const notes: DependabotView["notes"] = {};
  const saved = new Map(app.dependabotStore.listExplanations().map((note) => [`${note.repo}#${note.number}`, note]));
  for (const item of active) {
    const note = saved.get(`${item.pr.repo.toLowerCase()}#${item.pr.number}`);
    if (note && note.fingerprint === explanationFingerprint(item)) {
      notes[`${item.pr.repo}#${item.pr.number}`] = { text: note.text, model: note.model, createdAt: note.createdAt };
    }
  }

  const schedule = app.getDependabotSchedule();
  const next = nextSlot(schedule, now);

  return {
    canCheck: app.dependabot !== null,
    unavailableReason:
      app.dependabot === null
        ? "Checking needs a GitHub token. Set GITLIB_GITHUB_TOKEN (or GITHUB_TOKEN) in the server's environment and restart it."
        : null,
    running: lease ? { by: lease.holder, since: lease.takenAt } : null,
    run: run ? { id: run.id, trigger: run.trigger, checkedAt: run.report.checkedAt, finishedAt: run.finishedAt } : null,
    items: active,
    dismissed,
    report: run ? withoutItems(run.report) : null,
    counts,
    notes,
    explainer: {
      enabled: app.chat !== null,
      active: explainer?.started ?? false,
      pending: app.chat ? pendingFindings(app, now).length : 0,
      lastError: explainer?.state.lastError ?? null,
    },
    schedule: {
      enabled: schedule.enabled,
      days: schedule.days,
      time: schedule.time,
      nextRunAt: next ? next.toISOString() : null,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      active: scheduler?.started ?? false,
      lastAttemptAt: scheduler?.state.lastAttemptAt ?? null,
      lastError: scheduler?.state.lastError ?? null,
    },
  };
}

/** Just the numbers for the NavBar: how many pull requests need a person, by bucket. */
export function buildBadge(now: Date = new Date(), app: GitLibApp = getApp()): DependabotBadge {
  const { counts, run } = buildView(now, app);
  return {
    actionable: BUCKETS.filter((bucket) => bucket !== "waiting").reduce((sum, bucket) => sum + counts[bucket], 0),
    counts,
    checkedAt: run?.checkedAt ?? null,
  };
}

/** Runs a check as the web page; resolves with a message when it could not be done (busy, no token, GitHub down). */
export async function runCheck(app: GitLibApp = getApp()): Promise<string | null> {
  try {
    await app.runDependabotCheck({ trigger: "web" });
    return null;
  } catch (caught) {
    if (isGitLibError(caught)) return caught.message;
    throw caught;
  }
}

/** Runs a change the user asked for (a dismissal, a schedule); resolves with a message when it was refused. */
export function attempt(change: () => void): string | null {
  try {
    change();
    return null;
  } catch (caught) {
    if (isGitLibError(caught)) return caught.message;
    throw caught;
  }
}
