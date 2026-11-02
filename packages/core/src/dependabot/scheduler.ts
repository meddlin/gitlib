import { isGitLibError } from "../errors.js";
import { DependabotBusyError, type StoredRun } from "./store.js";
import { isCheckDue } from "./schedule.js";
import type { StoredDependabotSchedule } from "../planning/types.js";
import type { DependabotBackend } from "./types.js";

/** After a check threw (a rejected token, GitHub down), leave GitHub alone this long before trying again. */
export const FAILURE_BACKOFF_MS = 30 * 60_000;
/** How often a started scheduler looks at the clock. */
export const TICK_MS = 60_000;

/** What the scheduler needs from the application; `GitLibApp` provides all of it. */
export interface SchedulerHost {
  readonly dependabot: DependabotBackend | null;
  getDependabotSchedule(): StoredDependabotSchedule;
  latestDependabotRun(): StoredRun | null;
  runDependabotCheck(options: { trigger: "schedule"; now: Date }): Promise<StoredRun>;
}

export type TickOutcome =
  /** The schedule is off, or no check is due. */
  | "idle"
  /** There is no GitHub token, so nothing can run. */
  | "no-token"
  /** A check is due but one failed a moment ago. */
  | "backoff"
  /** A check is due but another process holds the lock; it will do (or has done) the work. */
  | "busy"
  | "ran"
  | "failed";

export interface SchedulerState {
  /** When the scheduler last tried to run a check (successfully or not). */
  lastAttemptAt: string | null;
  /** Why the last scheduled attempt failed, until one succeeds. */
  lastError: string | null;
}

/**
 * Starts a check when the user's schedule says one is due. It keeps no record of what it has done beyond the failure
 * back-off: whether a check is due is read from the saved runs, so a restart or a second process (the CLI, a host
 * cron job) cannot make it run twice or skip a slot.
 */
export class DependabotScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private retryAt = 0;
  private running = false;
  private readonly status: SchedulerState = { lastAttemptAt: null, lastError: null };

  constructor(private readonly host: SchedulerHost) {}

  get state(): SchedulerState {
    return { ...this.status };
  }

  get started(): boolean {
    return this.timer !== undefined;
  }

  /** Looks at the clock now and then every minute. The timer never keeps the process alive. */
  start(intervalMs = TICK_MS): void {
    if (this.timer) return;
    const tick = () => void this.tick(new Date()).catch((error: unknown) => console.warn("Scheduled Dependabot check failed:", error));
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
    tick();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One look at the clock. Never throws for an expected failure; it is recorded in `state` instead. */
  async tick(now: Date): Promise<TickOutcome> {
    if (this.running) return "busy";
    if (!this.host.dependabot) return "no-token";
    if (!isCheckDue(this.host.getDependabotSchedule(), this.host.latestDependabotRun(), now)) return "idle";
    if (now.getTime() < this.retryAt) return "backoff";

    this.running = true;
    this.status.lastAttemptAt = now.toISOString();
    try {
      await this.host.runDependabotCheck({ trigger: "schedule", now });
      this.status.lastError = null;
      return "ran";
    } catch (error) {
      if (error instanceof DependabotBusyError) return "busy";
      // A bug is rethrown; anything the user can act on is a GitLibError with a message fit to show.
      if (!isGitLibError(error)) throw error;
      this.status.lastError = error.message;
      this.retryAt = now.getTime() + FAILURE_BACKOFF_MS;
      return "failed";
    } finally {
      this.running = false;
    }
  }
}
