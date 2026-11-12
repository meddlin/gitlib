import { COMMUNITY_ITEMS, TONE_CLASSES, scoreTone, type CommunityScoreEntry } from "#/lib/community";
import { cn } from "#/lib/utils";

/** What the hover text says when a repo has no score because of the Settings page, not because nothing was fetched. */
export const NOT_FAVORITED_HINT = "Community scores are only fetched for favorited repositories. Change this in Settings.";

/** The accessible name and hover text for a link that shows `entry`, so a screen reader hears what the squares show. */
export function describeScore(name: string, entry: CommunityScoreEntry): { label: string; title: string } {
  const missing = COMMUNITY_ITEMS.filter((item) => entry.missing.includes(item.id)).map((item) => item.label);
  return {
    label: `Community profile score ${entry.score}% for ${name}${missing.length > 0 ? `; missing ${missing.join(", ")}` : ""}`,
    title: missing.length > 0 ? `Missing: ${missing.join(", ")}` : "Nothing missing",
  };
}

/** A score with one square per checklist item, so what is missing shows without opening the repo. */
export function CommunityMeter({ entry }: { entry: CommunityScoreEntry }) {
  const tone = TONE_CLASSES[scoreTone(entry.score)];
  return (
    <>
      <span className={cn("text-sm font-medium", tone.text)}>{entry.score}%</span>
      <span className="flex gap-[3px]" aria-hidden>
        {COMMUNITY_ITEMS.map((item) => (
          <span
            key={item.id}
            className={cn("size-2", entry.missing.includes(item.id) ? "border border-muted-foreground/70" : tone.bar)}
          />
        ))}
      </span>
    </>
  );
}
