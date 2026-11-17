import { MarkdownBody } from "#/components/markdown-body";
import type { RemoteProvider } from "#/lib/catalog";
import type { RemoteReadme as RemoteReadmeView } from "#/lib/readme";
import { useServerData } from "#/lib/use-server-data";
import { getRemoteReadme } from "#/server/catalog";

const HOSTS: Record<RemoteProvider, string> = { github: "GitHub", gitlab: "GitLab" };

// `useServerData` takes one string key, so the pair travels as `provider:fullName`; the provider has no ":" to split on.
const keyOf = (provider: RemoteProvider, fullName: string) => `${provider}:${fullName}`;
const loadReadme = (key: string) => {
  const split = key.indexOf(":");
  return getRemoteReadme({ data: { provider: key.slice(0, split) as RemoteProvider, fullName: key.slice(split + 1) } });
};
const readmeFailed = (error: string): RemoteReadmeView => ({ fileName: null, markdown: null, error });

/** The README of a repo that only GitHub or GitLab has, read from the host and rendered like a local one. */
export function RemoteReadme({ provider, fullName }: { provider: RemoteProvider; fullName: string }) {
  const loaded = useServerData(keyOf(provider, fullName), loadReadme, readmeFailed);
  const readme = loaded.status === "done" ? loaded.value : null;

  return (
    <section className="mt-2 border-t pt-4" aria-label="README">
      <h3 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {readme?.fileName ?? "README"}
      </h3>
      {!readme ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : readme.error ? (
        <p role="alert" className="text-sm text-destructive">
          {readme.error}
        </p>
      ) : readme.fileName === null ? (
        <p className="text-sm text-muted-foreground">This repository has no README.</p>
      ) : readme.markdown === null ? (
        <p className="text-sm text-muted-foreground">
          This repository's README ({readme.fileName}) isn't Markdown, so it isn't shown here. Open the repository on{" "}
          {HOSTS[provider]} to read it.
        </p>
      ) : (
        <MarkdownBody>{readme.markdown}</MarkdownBody>
      )}
    </section>
  );
}
