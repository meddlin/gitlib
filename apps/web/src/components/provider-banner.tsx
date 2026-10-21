import { ExternalLink, Github, type LucideIcon } from "lucide-react";
import type { Provider } from "#/server/provider";

/** How each hosting service is presented. Add GitLab here when its fetchers exist. */
export const PROVIDERS: Record<Provider, { label: string; icon: LucideIcon }> = {
  github: { label: "GitHub", icon: Github },
};

/** Says plainly where the data below came from, and links to it. */
export function ProviderBanner({
  provider,
  noun,
  slug,
  url,
}: {
  provider: Provider;
  /** What the tab lists, capitalized: "Issues", "Pull requests". */
  noun: string;
  slug: string;
  url: string;
}) {
  const { label, icon: Icon } = PROVIDERS[provider];
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border bg-muted/40 px-3 py-2">
      <p className="inline-flex items-center gap-2 text-sm">
        <Icon className="size-4" aria-hidden />
        <span>
          {noun} from <span className="font-semibold">{label}</span>
        </span>
      </p>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Open ${slug} ${noun.toLowerCase()} on ${label}`}
        className="inline-flex items-center gap-1 font-mono text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {slug}
        <ExternalLink className="size-3" aria-hidden />
      </a>
    </div>
  );
}
