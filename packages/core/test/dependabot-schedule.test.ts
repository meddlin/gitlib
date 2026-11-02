import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DependabotAuthError,
  DependabotBusyError,
  DependabotScheduleError,
  DependabotScheduler,
  DEFAULT_DEPENDABOT_SCHEDULE,
  FAILURE_BACKOFF_MS,
  LATEST_SCHEMA_VERSION,
  RETRY_AFTER_MS,
  RETRY_WINDOW_MS,
  createApplication,
  isCheckDue,
  isGitLibError,
  nextSlot,
  normalizeSchedule,
  previousSlot,
  type DependabotSchedule,
  type SchedulerHost,
  type StoredDependabotSchedule,
  type StoredRun,
} from "../src/index.js";
import { FakeBackend, pr } from "./dependabot-fixtures.js";
import { Fixture } from "./fixture.js";

let fx: Fixture;
let originalTz: string | undefined;
beforeAll(() => {
  originalTz = process.env["TZ"];
});
afterAll(() => {
  if (originalTz === undefined) delete process.env["TZ"];
  else process.env["TZ"] = originalTz;
});
beforeEach(() => {
  // Slots are wall-clock times in the server's zone; pin it so the dates below mean what they say.
  process.env["TZ"] = "UTC";
  fx = new Fixture();
});
afterEach(() => fx.cleanup());

/** 2026-11-02 is a Monday. */
const at = (day: number, time: string) => new Date(`2026-11-${String(day).padStart(2, "0")}T${time}:00Z`);
const WEEKDAYS: DependabotSchedule = { enabled: true, days: [1, 2, 3, 4, 5], time: "08:00" };

describe("normalizeSchedule", () => {
  it("returns the days sorted and without repeats", () => {
    expect(normalizeSchedule({ enabled: true, days: [5, 1, 1, 3], time: "07:30" })).toEqual({ enabled: true, days: [1, 3, 5], time: "07:30" });
  });

  it("lets a schedule that is off have no days", () => {
    expect(normalizeSchedule({ enabled: false, days: [], time: "00:00" })).toEqual({ enabled: false, days: [], time: "00:00" });
  });

  it("refuses what the server could not follow, with a message for the page", () => {
    const refused = (input: object, message: string | RegExp) => {
      expect(() => normalizeSchedule(input)).toThrow(DependabotScheduleError);
      expect(() => normalizeSchedule(input)).toThrow(message);
    };
    refused({ enabled: "yes", days: [1], time: "08:00" }, "on or off");
    refused({ enabled: true, days: "1,2", time: "08:00" }, "weekdays");
    refused({ enabled: true, days: [7], time: "08:00" }, "weekdays");
    refused({ enabled: true, days: [1.5], time: "08:00" }, "weekdays");
    refused({ enabled: true, days: [-1], time: "08:00" }, "weekdays");
    refused({ enabled: true, days: [1], time: "8:00" }, "08:00");
    refused({ enabled: true, days: [1], time: "24:00" }, "08:00");
    refused({ enabled: true, days: [1], time: "08:60" }, "08:00");
    refused({ enabled: true, days: [1] }, "08:00");
    refused({ enabled: true, days: [], time: "08:00" }, "at least one day");
    expect(isGitLibError(new DependabotScheduleError("x"))).toBe(true);
  });
});

describe("slots", () => {
  it("finds the latest slot at or before now and the earliest after it", () => {
    // Monday 07:00: this morning's slot has not come yet, so the latest one was Friday's.
    expect(previousSlot(WEEKDAYS, at(2, "07:00"))).toEqual(new Date("2026-10-30T08:00:00Z"));
    expect(nextSlot(WEEKDAYS, at(2, "07:00"))).toEqual(at(2, "08:00"));
    // Exactly on a slot: it is the previous one, and the next is a day later.
    expect(previousSlot(WEEKDAYS, at(2, "08:00"))).toEqual(at(2, "08:00"));
    expect(nextSlot(WEEKDAYS, at(2, "08:00"))).toEqual(at(3, "08:00"));
    expect(previousSlot(WEEKDAYS, at(2, "08:01"))).toEqual(at(2, "08:00"));
  });

  it("skips days that are not scheduled, across a weekend", () => {
    // Sunday 8 November at noon.
    expect(previousSlot(WEEKDAYS, at(8, "12:00"))).toEqual(at(6, "08:00"));
    expect(nextSlot(WEEKDAYS, at(8, "12:00"))).toEqual(at(9, "08:00"));
    expect(nextSlot(WEEKDAYS, at(6, "08:00"))).toEqual(at(9, "08:00"));
  });

  it("reaches a whole week back or forward for a single weekly day", () => {
    const wednesdays: DependabotSchedule = { enabled: true, days: [3], time: "09:15" };
    expect(previousSlot(wednesdays, at(4, "09:14"))).toEqual(new Date("2026-10-28T09:15:00Z"));
    expect(nextSlot(wednesdays, at(4, "09:15"))).toEqual(at(11, "09:15"));
  });

  it("has no slots when the schedule is off or has no days", () => {
    expect(previousSlot({ ...WEEKDAYS, enabled: false }, at(2, "12:00"))).toBeNull();
    expect(nextSlot({ ...WEEKDAYS, enabled: false }, at(2, "12:00"))).toBeNull();
    expect(previousSlot({ ...WEEKDAYS, days: [] }, at(2, "12:00"))).toBeNull();
    expect(nextSlot({ ...WEEKDAYS, days: [] }, at(2, "12:00"))).toBeNull();
  });

  it("means the server's wall clock, including a zone that is not a whole hour from UTC", () => {
    process.env["TZ"] = "Asia/Kolkata"; // UTC+05:30, so 08:00 there is 02:30 UTC.
    expect(nextSlot(WEEKDAYS, at(2, "00:00"))).toEqual(at(2, "02:30"));
    expect(previousSlot(WEEKDAYS, at(2, "03:00"))).toEqual(at(2, "02:30"));
  });

  it("stays ordered across a clock change", () => {
    process.env["TZ"] = "America/New_York"; // 2026-03-08: 02:30 does not exist.
    const daily: DependabotSchedule = { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: "02:30" };
    let slot = nextSlot(daily, new Date("2026-03-06T12:00:00Z"))!;
    for (let i = 0; i < 5; i += 1) {
      const following = nextSlot(daily, slot)!;
      expect(following.getTime()).toBeGreaterThan(slot.getTime());
      expect(following.getTime() - slot.getTime()).toBeLessThan(26 * 3_600_000);
      slot = following;
    }
  });
});

describe("isCheckDue", () => {
  const saved = (overrides: Partial<StoredDependabotSchedule> = {}): StoredDependabotSchedule => ({ ...WEEKDAYS, updatedAt: "2026-10-01T00:00:00.000Z", ...overrides });
  const runAt = (startedAt: Date, options: { errors?: boolean; finishedAfterMs?: number } = {}): StoredRun =>
    ({
      id: 1,
      trigger: "schedule",
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + (options.finishedAfterMs ?? 5_000)).toISOString(),
      report: { errors: options.errors ? [{ owner: "x", message: "down" }] : [] },
    }) as unknown as StoredRun;

  it("is due when the latest slot came after the last run", () => {
    expect(isCheckDue(saved(), null, at(2, "08:01"))).toBe(true);
    expect(isCheckDue(saved(), runAt(at(2, "08:00")), at(3, "08:01"))).toBe(true);
    // Mid-morning, still the same slot.
    expect(isCheckDue(saved(), runAt(at(2, "08:00")), at(2, "11:00"))).toBe(false);
  });

  it("is not due before the first slot, or when the schedule is off", () => {
    expect(isCheckDue(saved({ enabled: false }), null, at(2, "12:00"))).toBe(false);
    expect(isCheckDue(saved({ days: [] }), null, at(2, "12:00"))).toBe(false);
  });

  it("counts a check started any other way as satisfying the slot", () => {
    // Someone pressed Check now at 08:30; the 08:00 slot needs nothing more.
    expect(isCheckDue(saved(), runAt(at(2, "08:30")), at(2, "09:00"))).toBe(false);
  });

  it("catches up on a slot missed while the server was down", () => {
    // Last ran Monday 08:00; the server was off through Tuesday's slot and is back on Tuesday afternoon.
    expect(isCheckDue(saved(), runAt(at(2, "08:00")), at(3, "15:00"))).toBe(true);
  });

  it("does not catch up on a slot from before the schedule was saved", () => {
    // Turned on Monday at 14:00: this morning's 08:00 is not owed.
    expect(isCheckDue(saved({ updatedAt: at(2, "14:00").toISOString() }), null, at(2, "14:01"))).toBe(false);
    expect(isCheckDue(saved({ updatedAt: at(2, "14:00").toISOString() }), null, at(3, "08:00"))).toBe(true);
  });

  it("retries a check that could not ask some owner, after a while and not for ever", () => {
    const failed = runAt(at(2, "08:00"), { errors: true });
    const finished = Date.parse(failed.finishedAt);
    expect(isCheckDue(saved(), failed, new Date(finished + RETRY_AFTER_MS - 1_000))).toBe(false);
    expect(isCheckDue(saved(), failed, new Date(finished + RETRY_AFTER_MS))).toBe(true);
    // Hours later with the same permanent failure: leave it until the next slot.
    expect(isCheckDue(saved(), runAt(at(2, "08:00"), { errors: true }), new Date(at(2, "08:00").getTime() + RETRY_WINDOW_MS))).toBe(false);
    // A clean run is never retried.
    expect(isCheckDue(saved(), runAt(at(2, "08:00")), new Date(finished + RETRY_AFTER_MS))).toBe(false);
  });
});

describe("DependabotScheduler", () => {
  class Host implements SchedulerHost {
    dependabot: SchedulerHost["dependabot"] = new FakeBackend({});
    schedule: StoredDependabotSchedule = { ...WEEKDAYS, updatedAt: "2026-10-01T00:00:00.000Z" };
    last: StoredRun | null = null;
    runs: Date[] = [];
    failWith: unknown = null;
    gate: Promise<void> | null = null;

    getDependabotSchedule() {
      return this.schedule;
    }
    latestDependabotRun() {
      return this.last;
    }
    async runDependabotCheck(options: { trigger: "schedule"; now: Date }): Promise<StoredRun> {
      this.runs.push(options.now);
      await this.gate;
      if (this.failWith) throw this.failWith;
      this.last = {
        id: this.runs.length,
        trigger: options.trigger,
        startedAt: options.now.toISOString(),
        finishedAt: options.now.toISOString(),
        report: { errors: [] },
      } as unknown as StoredRun;
      return this.last;
    }
  }

  it("does nothing while the schedule is off or nothing is due", async () => {
    const host = new Host();
    const scheduler = new DependabotScheduler(host);
    host.schedule = { ...host.schedule, enabled: false };
    expect(await scheduler.tick(at(2, "09:00"))).toBe("idle");
    host.schedule = { ...host.schedule, enabled: true };
    expect(await scheduler.tick(at(2, "07:00"))).toBe("ran"); // Friday's slot was never run.
    expect(await scheduler.tick(at(2, "07:30"))).toBe("idle");
    expect(host.runs).toHaveLength(1);
  });

  it("runs a due check once and then leaves it until the next slot", async () => {
    const host = new Host();
    const scheduler = new DependabotScheduler(host);

    expect(await scheduler.tick(at(2, "08:00"))).toBe("ran");
    expect(host.runs).toEqual([at(2, "08:00")]);
    expect(await scheduler.tick(at(2, "08:01"))).toBe("idle");
    expect(await scheduler.tick(at(2, "20:00"))).toBe("idle");
    expect(await scheduler.tick(at(3, "08:00"))).toBe("ran");
    expect(scheduler.state).toEqual({ lastAttemptAt: at(3, "08:00").toISOString(), lastError: null });
  });

  it("does not run without a GitHub token", async () => {
    const host = new Host();
    host.dependabot = null;
    expect(await new DependabotScheduler(host).tick(at(2, "09:00"))).toBe("no-token");
    expect(host.runs).toEqual([]);
  });

  it("records a failure, backs off, and tries again afterwards", async () => {
    const host = new Host();
    host.failWith = new DependabotAuthError("GitHub rejected the token (401).");
    const scheduler = new DependabotScheduler(host);

    expect(await scheduler.tick(at(2, "08:00"))).toBe("failed");
    expect(scheduler.state.lastError).toBe("GitHub rejected the token (401).");
    // Every minute afterwards the check is still due, but GitHub is left alone.
    expect(await scheduler.tick(at(2, "08:01"))).toBe("backoff");
    expect(await scheduler.tick(new Date(at(2, "08:00").getTime() + FAILURE_BACKOFF_MS - 1_000))).toBe("backoff");
    expect(host.runs).toHaveLength(1);

    host.failWith = null;
    expect(await scheduler.tick(new Date(at(2, "08:00").getTime() + FAILURE_BACKOFF_MS))).toBe("ran");
    expect(scheduler.state.lastError).toBeNull();
  });

  it("stays quiet when another process is already checking", async () => {
    const host = new Host();
    host.failWith = new DependabotBusyError("A Dependabot check is already running (started now by cli).");
    const scheduler = new DependabotScheduler(host);
    expect(await scheduler.tick(at(2, "08:00"))).toBe("busy");
    expect(scheduler.state.lastError).toBeNull();
    // No back-off either: the other process may well have finished by the next minute.
    host.failWith = null;
    expect(await scheduler.tick(at(2, "08:01"))).toBe("ran");
  });

  it("lets a bug through rather than hiding it", async () => {
    const host = new Host();
    host.failWith = new TypeError("a bug");
    await expect(new DependabotScheduler(host).tick(at(2, "08:00"))).rejects.toThrow("a bug");
  });

  it("never starts a second check while one is in flight", async () => {
    const host = new Host();
    let release!: () => void;
    host.gate = new Promise<void>((resolve) => (release = resolve));
    const scheduler = new DependabotScheduler(host);

    const first = scheduler.tick(at(2, "08:00"));
    expect(await scheduler.tick(at(2, "08:00"))).toBe("busy");
    release();
    expect(await first).toBe("ran");
    expect(host.runs).toHaveLength(1);
  });

  describe("on a timer", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("looks at the clock at once and then every interval, until stopped", async () => {
      vi.setSystemTime(at(2, "08:00"));
      const host = new Host();
      const scheduler = new DependabotScheduler(host);
      expect(scheduler.started).toBe(false);

      scheduler.start(60_000);
      scheduler.start(60_000); // a second start changes nothing
      expect(scheduler.started).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(host.runs).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(24 * 3_600_000);
      expect(host.runs).toHaveLength(2); // Tuesday's slot, and no more

      scheduler.stop();
      expect(scheduler.started).toBe(false);
      await vi.advanceTimersByTimeAsync(24 * 3_600_000);
      expect(host.runs).toHaveLength(2);
    });
  });
});

describe("the saved schedule", () => {
  it("is off until the user saves one, then survives a new application over the same data", () => {
    fx.writeConfig();
    const app = createApplication(fx.env());
    expect(app.getDependabotSchedule()).toEqual({ ...DEFAULT_DEPENDABOT_SCHEDULE, updatedAt: null });
    expect(DEFAULT_DEPENDABOT_SCHEDULE.enabled).toBe(false);

    const saved = app.saveDependabotSchedule({ enabled: true, days: [2, 4], time: "06:45" });
    expect(saved).toMatchObject({ enabled: true, days: [2, 4], time: "06:45" });
    expect(saved.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    expect(createApplication(fx.env()).getDependabotSchedule()).toEqual(saved);
    app.saveDependabotSchedule({ enabled: false, days: [], time: "06:45" });
    expect(createApplication(fx.env()).getDependabotSchedule()).toMatchObject({ enabled: false, days: [] });
  });

  it("is refused when invalid, and nothing is saved", () => {
    fx.writeConfig();
    const app = createApplication(fx.env());
    expect(() => app.saveDependabotSchedule({ enabled: true, days: [], time: "06:45" })).toThrow(DependabotScheduleError);
    expect(app.getDependabotSchedule().updatedAt).toBeNull();
  });

  it("arrives through migration 5", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(5);
  });
});

describe("a scheduler over a real application", () => {
  it("runs a due check as the schedule, saves it, and then has nothing left to do", async () => {
    fx.writeConfig();
    const repoPath = fx.initRealGitRepo("gitlib");
    fx.git(repoPath, "remote", "add", "origin", "https://github.com/meddlin/gitlib.git");
    const app = createApplication(fx.env(), undefined, null, null, new FakeBackend({ meddlin: { prs: [pr({ number: 1 })] } }));
    app.refresh();
    app.saveRepositoryFavorite("gitlib", true);
    app.saveDependabotSchedule({ enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: "00:00" });
    const scheduler = app.createDependabotScheduler();

    // Saved just now, so today's slot is not owed; tomorrow's is.
    expect(await scheduler.tick(new Date())).toBe("idle");
    const tomorrow = new Date(Date.now() + 25 * 3_600_000);
    expect(await scheduler.tick(tomorrow)).toBe("ran");

    expect(app.latestDependabotRun()).toMatchObject({ trigger: "schedule" });
    expect(app.latestDependabotRun()?.report.items).toHaveLength(1);
    expect(await scheduler.tick(new Date(tomorrow.getTime() + 60_000))).toBe("idle");
    expect(app.dependabotStore.currentLease(new Date())).toBeNull();
  });
});
