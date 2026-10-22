import { Link, createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { ArrowLeft, CircleCheck, CircleDot, Pencil } from "lucide-react";
import { useState } from "react";
import { IssueFormDialog } from "#/components/issue-form-dialog";
import { MarkdownBody } from "#/components/markdown-body";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { NativeSelect } from "#/components/ui/native-select";
import { formatDate } from "#/lib/format";
import { STATUS_COLUMNS, isStatus } from "#/lib/issue-status";
import { getLocalIssue, setLocalIssueState, setLocalIssueStatus } from "#/server/planning";

export const Route = createFileRoute("/planning/issues/$id")({
  loader: async ({ params }) => {
    const id = Number(params.id);
    const detail = Number.isInteger(id) && id > 0 ? await getLocalIssue({ data: { id } }) : null;
    if (!detail) throw notFound();
    return detail;
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData ? `${loaderData.issue.title} · ` : ""}Planning · Gitlib` }],
  }),
  notFoundComponent: IssueNotFound,
  component: IssueDetail,
});

function BackLink() {
  return (
    <Link
      to="/planning"
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="size-3.5" aria-hidden /> Planning
    </Link>
  );
}

function IssueNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-8 sm:px-6">
      <BackLink />
      <p className="border-y py-10 text-center text-sm text-muted-foreground">Gitlib doesn't have that issue.</p>
    </div>
  );
}

function IssueDetail() {
  const { issue, limits } = Route.useLoaderData();
  const router = useRouter();
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = issue.state === "open";

  async function toggleState() {
    setChanging(true);
    setError(null);
    try {
      await setLocalIssueState({ data: { id: issue.id, state: open ? "closed" : "open" } });
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the issue's state.");
    } finally {
      setChanging(false);
    }
  }

  async function changeStatus(status: string) {
    if (!isStatus(status)) return;
    setChanging(true);
    setError(null);
    try {
      await setLocalIssueStatus({ data: { id: issue.id, status } });
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the issue's status.");
    } finally {
      setChanging(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <BackLink />

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight break-words">
            {issue.title} <span className="font-normal text-muted-foreground">#{issue.number}</span>
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <Badge variant={open ? "default" : "secondary"}>
              {open ? <CircleDot aria-hidden /> : <CircleCheck aria-hidden />}
              {open ? "Open" : "Closed"}
            </Badge>
            {issue.repoKnown ? (
              <Link
                to="/repos/$"
                params={{ _splat: issue.repoPath }}
                className="font-mono text-xs outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                {issue.repoPath}
              </Link>
            ) : (
              <span className="font-mono text-xs" title="Gitlib no longer finds this repository. It may have moved; try a rescan.">
                {issue.repoPath} (not found)
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <IssueFormDialog mode="edit" issue={issue} limits={limits}>
            <Button variant="outline">
              <Pencil aria-hidden /> Edit
            </Button>
          </IssueFormDialog>
          <NativeSelect
            aria-label="Status"
            value={issue.status}
            onChange={(event) => void changeStatus(event.target.value)}
            disabled={changing}
            className="w-auto"
          >
            {STATUS_COLUMNS.map((column) => (
              <option key={column.status} value={column.status}>
                {column.label}
              </option>
            ))}
          </NativeSelect>
          <Button variant="outline" onClick={toggleState} disabled={changing}>
            {open ? "Close issue" : "Reopen issue"}
          </Button>
        </div>
      </header>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <section aria-label="Description" className="border-y py-4">
        {issue.body ? (
          <MarkdownBody>{issue.body}</MarkdownBody>
        ) : (
          <p className="text-sm text-muted-foreground">No description provided.</p>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        Opened {formatDate(issue.createdAt)}
        {issue.updatedAt !== issue.createdAt ? ` · updated ${formatDate(issue.updatedAt)}` : ""}
        {issue.closedAt ? ` · closed ${formatDate(issue.closedAt)}` : ""} · stored in gitlib only
      </p>
    </div>
  );
}
