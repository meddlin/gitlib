import { FolderGit2, Pencil } from "lucide-react";
import { Highlighted } from "#/components/highlighted";
import { DescriptionDialog } from "#/components/description-dialog";
import { TechBadge } from "#/components/tech-badge";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import type { RepoView } from "#/server/repos";
import type { SearchHitView } from "#/server/search";

const SNIPPETS = [
  ["notes", "Notes"],
  ["readme", "README"],
] as const;

export function RepoCard({
  repo,
  activeTech,
  highlights,
  onToggleTech,
}: {
  repo: RepoView;
  activeTech: string | undefined;
  /** Search matches for this repo, when it is being shown as a search result. */
  highlights?: SearchHitView["highlights"];
  onToggleTech: (name: string) => void;
}) {
  const key = repo.technologies.filter((t) => t.category === "language" || t.category === "framework");
  const other = repo.technologies.filter((t) => t.category !== "language" && t.category !== "framework");

  return (
    <Card className="w-full gap-4" data-testid="repo-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FolderGit2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">
            <Highlighted segments={highlights?.name} fallback={repo.name} />
          </span>
        </CardTitle>
        <CardDescription className="truncate font-mono text-xs" title={repo.absolutePath}>
          <Highlighted segments={highlights?.relativePath} fallback={repo.relativePath} />
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {repo.description ? (
          <p className="text-sm leading-relaxed">
            <Highlighted segments={highlights?.description} fallback={repo.description} />
          </p>
        ) : (
          <p className="text-sm italic text-muted-foreground">No description yet.</p>
        )}

        {SNIPPETS.map(([field, label]) => {
          const segments = highlights?.[field];
          return segments ? (
            <p key={field} className="rounded-md bg-muted/50 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              <span className="mr-1.5 font-medium text-foreground">{label}</span>
              <Highlighted segments={segments} fallback="" />
            </p>
          ) : null;
        })}

        <div className="mt-auto flex flex-col gap-3">
          {repo.technologies.length === 0 ? (
            <p className="text-xs text-muted-foreground">No languages or frameworks detected.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {[...key, ...other].map((tech) => (
                <button
                  key={tech.name}
                  type="button"
                  onClick={() => onToggleTech(tech.name)}
                  aria-label={`Filter by ${tech.name}`}
                  className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <TechBadge
                    name={tech.name}
                    category={tech.category}
                    active={activeTech?.toLowerCase() === tech.name.toLowerCase()}
                  />
                </button>
              ))}
            </div>
          )}

          <DescriptionDialog repo={repo}>
            <Button variant="outline" size="sm" className="w-fit">
              <Pencil aria-hidden />
              {repo.description ? "Edit description" : "Add description"}
            </Button>
          </DescriptionDialog>
        </div>
      </CardContent>
    </Card>
  );
}
