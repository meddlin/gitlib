import type { DependabotDismissal } from "../planning/types.js";

/** A dismissal that still hides its pull request at `now`: dismissed until closed, or snoozed and not yet due. */
export function isDismissalActive(dismissal: DependabotDismissal, now: Date): boolean {
  return dismissal.snoozedUntil === null || Date.parse(dismissal.snoozedUntil) > now.getTime();
}

/**
 * Splits findings into those to act on and those the user put aside. A dismissal applies to a pull request by
 * repository (without regard to case) and number, so a PR that Dependabot replaces with a new number comes back.
 */
export function splitDismissed<T extends { pr: { repo: string; number: number } }>(
  items: readonly T[],
  dismissals: readonly DependabotDismissal[],
  now: Date,
): { active: T[]; dismissed: (T & { dismissal: DependabotDismissal })[] } {
  const hiding = new Map<string, DependabotDismissal>();
  for (const dismissal of dismissals) {
    if (isDismissalActive(dismissal, now)) hiding.set(`${dismissal.repo.toLowerCase()}#${dismissal.number}`, dismissal);
  }
  const active: T[] = [];
  const dismissed: (T & { dismissal: DependabotDismissal })[] = [];
  for (const item of items) {
    const dismissal = hiding.get(`${item.pr.repo.toLowerCase()}#${item.pr.number}`);
    if (dismissal) dismissed.push({ ...item, dismissal });
    else active.push(item);
  }
  return { active, dismissed };
}
