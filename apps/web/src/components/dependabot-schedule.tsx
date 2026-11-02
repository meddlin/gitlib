import { CalendarClock } from "lucide-react";
import { useEffect, useState } from "react";
import { RelativeTime } from "#/components/relative-time";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { WEEKDAY_ORDER, WEEKDAY_NAMES, describeSchedule } from "#/lib/dependabot";
import type { DependabotView } from "#/server/dependabot";

type Schedule = DependabotView["schedule"];

/** Turns the automatic check on or off and picks its days and time. The server's clock decides when it fires. */
export function SchedulePanel({
  schedule,
  saving,
  onSave,
}: {
  schedule: Schedule;
  saving: boolean;
  onSave: (next: { enabled: boolean; days: number[]; time: string }) => void;
}) {
  const [enabled, setEnabled] = useState(schedule.enabled);
  const [days, setDays] = useState<number[]>(schedule.days);
  const [time, setTime] = useState(schedule.time);

  // What the server saved wins, so the form never shows a schedule that is not the one in force.
  useEffect(() => {
    setEnabled(schedule.enabled);
    setDays(schedule.days);
    setTime(schedule.time);
  }, [schedule.enabled, schedule.days, schedule.time]);

  const changed = enabled !== schedule.enabled || time !== schedule.time || days.join() !== schedule.days.join();
  const toggleDay = (day: number) => setDays((current) => (current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort()));

  return (
    <section id="schedule" aria-labelledby="schedule-heading" className="flex scroll-mt-16 flex-col gap-3 rounded-lg border p-4">
      <div>
        <h2 id="schedule-heading" className="flex items-center gap-2 text-lg font-medium">
          <CalendarClock className="size-4" aria-hidden /> Schedule
        </h2>
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {schedule.enabled ? `Checks run ${describeSchedule(schedule)}.` : "Off: gitlib only checks when you ask."}
          {schedule.enabled && schedule.nextRunAt ? (
            <>
              {" "}
              Next check: <RelativeTime iso={schedule.nextRunAt} />.
            </>
          ) : null}
        </p>
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ enabled, days, time });
        }}
      >
        <label className="flex items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="size-4 accent-primary" />
          Check automatically
        </label>

        <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" disabled={!enabled}>
          <legend className="sr-only">Days</legend>
          {WEEKDAY_ORDER.map((day) => (
            <label key={day} className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={days.includes(day)} onChange={() => toggleDay(day)} className="size-4 accent-primary" />
              {WEEKDAY_NAMES[day]}
            </label>
          ))}
        </fieldset>

        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="inline-flex items-center gap-2">
            At
            <Input type="time" value={time} onChange={(event) => setTime(event.target.value)} disabled={!enabled} required className="h-8 w-28" />
          </label>
          <span className="text-muted-foreground">Server time ({schedule.timeZone}).</span>
          <Button type="submit" size="sm" disabled={saving || !changed} className="ml-auto">
            {saving ? "Saving…" : "Save schedule"}
          </Button>
        </div>
      </form>

      {schedule.lastError ? (
        <p role="alert" className="text-sm text-destructive">
          The last scheduled check failed{schedule.lastAttemptAt ? <> (<RelativeTime iso={schedule.lastAttemptAt} />)</> : null}: {schedule.lastError}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        The schedule runs inside this web server, so it only runs while the server is up; after a restart it catches up on a check it missed. Checks
        from the schedule, the Check now button and <code className="rounded bg-muted px-1 font-mono">gitlib dependabot check</code> (for example from a host cron job) share one lock, so they
        never overlap, and any of them counts for the slot.{!schedule.active ? " The scheduler has not started in this server yet." : ""}
      </p>
    </section>
  );
}
