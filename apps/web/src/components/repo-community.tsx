import { Link } from "@tanstack/react-router";
import { Check, ListPlus, X } from "lucide-react";
import { useState } from "react";
import { PROVIDERS, ProviderBanner } from "#/components/provider-banner";
import { Button } from "#/components/ui/button";
import { TONE_CLASSES, missingItems, planningIssueDraft, scoreTone, type CommunityItem } from "#/lib/community";
import { cn } from "#/lib/utils";
import { useServerData } from "#/lib/use-server-data";
import { getCommunityProfile, type CommunityView } from "#/server/community";
import { createLocalIssue, getRepoLocalIssues, type LocalIssueView } from "#/server/planning";

const loadCommunity = (relativePath: string) => getCommunityProfile({ data: { relativePath } });
const communityFailed = (error: string): CommunityView => ({
  provider: null,
  slug: null,
  communityUrl: null,
  profile: null,
  error,
});

const loadPlanned = (relativePath: string) => getRepoLocalIssues({ data: { relativePath } });

/** Files a gitlib planning issue (stored in gitlib only) for one missing item, or links to the one already open. */
function PlanAction({
  item,
  relativePath,
  draft,
  planned,
  onFiled,
}: {
  item: CommunityItem;
  relativePath: string;
  draft: { title: string; body: string };
  planned: LocalIssueView | undefined;
  onFiled: (issue: LocalIssueView) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (planned) {
    return (
      <Link
        to="/planning/issues/$id"
        params={{ id: String(planned.id) }}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Check className="size-3" aria-hidden />
        Planned as {planned.repoName}#{planned.number}
      </Link>
    );
  }

  async function file() {
    setSaving(true);
    setError(null);
    try {
      onFiled(await createLocalIssue({ data: { repo: relativePath, ...draft } }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not file the issue.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={file}
        disabled={saving}
        aria-label={`Add "${draft.title}" to planning`}
        title="File a planning issue in gitlib (nothing is created on GitHub)"
      >
        <ListPlus aria-hidden />
        {saving ? "Adding…" : "Add to planning"}
      </Button>
      {error ? (
        <p role="alert" className="max-w-48 text-right text-xs text-destructive">
          {item.label}: {error}
        </p>
      ) : null}
    </div>
  );
}

function Item({ item, action }: { item: CommunityItem; action?: React.ReactNode }) {
  const Icon = item.present ? Check : X;
  return (
    <li className="flex items-start gap-3 py-3">
      <Icon
        className={cn("mt-0.5 size-4 shrink-0", item.present ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}
        aria-label={item.present ? "Present" : "Missing"}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {item.present && item.url ? (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {item.label}
            </a>
          ) : (
            item.label
          )}
        </p>
        <p className="text-xs text-muted-foreground">{item.hint}</p>
      </div>
      {action}
    </li>
  );
}

export function RepoCommunity({ relativePath, canPlan }: { relativePath: string; canPlan: boolean }) {
  const loaded = useServerData(relativePath, loadCommunity, communityFailed);
  const existing = useServerData(relativePath, loadPlanned, () => []);
  // Issues filed from this tab; the server copy above was read when the tab opened.
  const [filed, setFiled] = useState<{ path: string; issues: LocalIssueView[] }>({ path: relativePath, issues: [] });

  if (loaded.status === "loading") return <p className="text-sm text-muted-foreground">Loading community profile…</p>;

  const view = loaded.value;
  const provider = view.provider ? PROVIDERS[view.provider] : null;
  if (!view.provider || !provider || !view.slug || !view.communityUrl) {
    return view.error ? (
      <p role="alert" className="text-sm text-destructive">
        {view.error}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">
        This repository has no GitHub remote, so there is no community profile to show.
      </p>
    );
  }

  const banner = <ProviderBanner provider={view.provider} noun="Community profile" slug={view.slug} url={view.communityUrl} />;
  if (!view.profile) {
    return (
      <section aria-label={`Community profile from ${provider.label}`}>
        {banner}
        <p role="alert" className="text-sm text-destructive">
          {view.error ?? "Could not load the community profile."}
        </p>
      </section>
    );
  }

  const { score, items } = view.profile;
  const missing = missingItems(view.profile);
  const present = items.filter((item) => item.present);
  const tone = TONE_CLASSES[scoreTone(score)];
  const planned = [...(filed.path === relativePath ? filed.issues : []), ...(existing.status === "done" ? existing.value : [])];
  const plannedFor = (title: string) => planned.find((issue) => issue.state === "open" && issue.title === title);

  return (
    <section aria-label={`Community profile from ${provider.label}`}>
      {banner}

      <div className="flex items-end gap-4 border-b pb-4">
        <p className={cn("text-4xl font-semibold tabular-nums", tone.text)} data-testid="community-score">
          {score}%
        </p>
        <div className="min-w-0 flex-1 pb-1.5">
          <div
            role="meter"
            aria-label="Community profile score"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={score}
            className="h-2 w-full bg-muted"
          >
            <div className={cn("h-full", tone.bar)} style={{ width: `${score}%` }} />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {missing.length === 0
              ? "Every recommended community file is in place."
              : `${missing.length} of ${items.length} recommended items missing.`}
          </p>
        </div>
      </div>

      {missing.length > 0 ? (
        <>
          <h3 className="mt-4 text-xs font-medium tracking-wide text-muted-foreground uppercase">Missing ({missing.length})</h3>
          <ul className="divide-y" data-testid="community-missing">
            {missing.map((item) => {
              const draft = planningIssueDraft(item, { slug: view.slug!, score });
              return (
                <Item
                  key={item.id}
                  item={item}
                  action={
                    canPlan && existing.status === "done" ? (
                      <PlanAction
                        item={item}
                        relativePath={relativePath}
                        draft={draft}
                        planned={plannedFor(draft.title)}
                        onFiled={(issue) =>
                          setFiled((prev) => ({
                            path: relativePath,
                            issues: [issue, ...(prev.path === relativePath ? prev.issues : [])],
                          }))
                        }
                      />
                    ) : null
                  }
                />
              );
            })}
          </ul>
        </>
      ) : null}

      {present.length > 0 ? (
        <>
          <h3 className="mt-4 text-xs font-medium tracking-wide text-muted-foreground uppercase">In place ({present.length})</h3>
          <ul className="divide-y" data-testid="community-present">
            {present.map((item) => (
              <Item key={item.id} item={item} />
            ))}
          </ul>
        </>
      ) : null}

      <p className="mt-4 text-xs text-muted-foreground">
        The score is GitHub's own. For its full checklist, and to add what's missing,{" "}
        <a href={view.communityUrl} target="_blank" rel="noopener noreferrer" className="underline">
          open the community page on {provider.label}
        </a>
        .
      </p>
    </section>
  );
}
