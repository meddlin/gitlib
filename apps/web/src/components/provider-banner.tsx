import { ExternalLink } from "lucide-react";
import type { ComponentProps } from "react";
import type { Provider } from "#/server/provider";

/** lucide-react dropped brand icons in 1.0, so the GitHub mark lives here. */
function Github(props: ComponentProps<"svg">) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

/** How each hosting service is presented. Add GitLab here when its fetchers exist. */
export const PROVIDERS: Record<Provider, { label: string; icon: typeof Github }> = {
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
