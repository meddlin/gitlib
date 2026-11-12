import { useEffect, useState } from "react";
import { DEFAULT_COMMUNITY_SCOPE, type CommunityScope } from "#/lib/community";
import { cn } from "#/lib/utils";
import { getCommunityScope, saveCommunityScope } from "#/server/community";

const OPTIONS: readonly { id: CommunityScope; label: string; description: string }[] = [
  {
    id: "favorites",
    label: "Favorited repositories",
    description:
      "Fetch and show GitHub's community score only for repositories you've favorited. This is the default: a repository you haven't favorited probably isn't one you're investing in.",
  },
  {
    id: "all",
    label: "All repositories",
    description:
      "Fetch and show it for every repository, including GitHub repositories you haven't cloned. That is one GitHub request each, so a long list takes a while and uses more of your rate limit.",
  },
];

/** Settings for which repositories get a GitHub community score. */
export function CommunityScoreSettings() {
  const [scope, setScope] = useState<CommunityScope>(DEFAULT_COMMUNITY_SCOPE);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getCommunityScope()
      .then((current) => {
        setScope(current);
        setLoaded(true);
      })
      .catch(() => setError("Could not read the current setting."));
  }, []);

  const choose = async (next: CommunityScope) => {
    if (next === scope || saving) return;
    const previous = scope;
    setScope(next);
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      setScope(await saveCommunityScope({ data: { scope: next } }));
      setSaved(true);
    } catch {
      setScope(previous);
      setError("Could not save. See the server log.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="community-scope-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="community-scope-heading" className="text-lg font-medium">
          Community scores
        </h2>
        <p className="text-sm text-muted-foreground">
          Which repositories get a GitHub community score in the repository list. Opening a repository's own page always shows its
          score. Saved on the server, so it applies in every browser.
        </p>
      </div>

      <div role="radiogroup" aria-labelledby="community-scope-heading" className="grid gap-3 sm:grid-cols-2">
        {OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={scope === option.id}
            disabled={!loaded || saving}
            onClick={() => void choose(option.id)}
            className={cn(
              "flex flex-col gap-1 rounded-xl border bg-card p-3 text-left text-card-foreground transition-colors outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
              scope === option.id && "border-primary ring-2 ring-primary/40",
            )}
          >
            <span className="text-sm font-medium">{option.label}</span>
            <span className="text-xs text-muted-foreground">{option.description}</span>
          </button>
        ))}
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {saved ? "Saved." : null}
      </p>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
