import { useMemo } from "react";
import Markdown, { type Components, type Options } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  README_SCHEMA,
  imageDimension,
  isRemoteUrl,
  usableImageUrl,
  type ImageResolver,
} from "#/lib/markdown";

const NOT_A_WEB_LINK = "Not a web link, so it isn't clickable here";

// Raw HTML is parsed, then cut down to README_SCHEMA's allow-list, before anything is rendered.
const README_REHYPE_PLUGINS: NonNullable<Options["rehypePlugins"]> = [rehypeRaw, [rehypeSanitize, README_SCHEMA]];

/**
 * Only absolute http(s) links are live: a README's relative ones point into a repo on disk, which the browser can't
 * reach, so they read as text (with a hint) instead of navigating anywhere. Images follow the same rule, except
 * that a relative one is fetched from wherever the caller's `resolveImage` says (a route that serves files from
 * inside the repo, say) and is shown as `[alt]` when there is none.
 */
function readmeComponents(resolveImage: ImageResolver | undefined): Components {
  return {
    a: ({ href, children }) =>
      isRemoteUrl(href) ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          {children}
        </a>
      ) : (
        <span title={NOT_A_WEB_LINK}>{children}</span>
      ),
    img: ({ src, alt, title, width, height }) => {
      const url = typeof src !== "string" ? null : isRemoteUrl(src) ? src : usableImageUrl(resolveImage?.(src));
      if (!url) return alt ? <span className="text-muted-foreground">[{alt}]</span> : null;
      return (
        <img
          src={url}
          alt={alt ?? ""}
          title={title}
          width={imageDimension(width)}
          height={imageDimension(height)}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      );
    },
  };
}

// Text written by a model is shaped by whatever it was shown, including a hostile README, so it never loads an
// image (the browser would fetch the address, which can carry the conversation out), shows where a link goes and
// drops raw HTML (an <img> in it would load an address just the same).
const UNTRUSTED_COMPONENTS: Components = {
  a: ({ href, children }) =>
    isRemoteUrl(href) ? (
      <a href={href} title={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span title={NOT_A_WEB_LINK}>{children}</span>
    ),
  img: ({ alt }) => (alt ? <span className="text-muted-foreground">[image: {alt}]</span> : null),
};

/**
 * Renders Markdown from a README or an issue body; `untrusted` is for text a model wrote.
 *
 * Trusted text may contain raw HTML (`<p align="center">`, `<img width>`, `<details>`, tables ...), shown through an
 * allow-list: no scripts, styles, event handlers, frames or forms, and `href`/`src` stay absolute http(s).
 * `resolveImage` maps a relative image path (`docs/logo.png`) to a URL it can load; it is ignored when `untrusted`.
 */
export function MarkdownBody({
  children,
  untrusted = false,
  resolveImage,
}: {
  children: string;
  untrusted?: boolean;
  resolveImage?: ImageResolver;
}) {
  const components = useMemo(() => (untrusted ? UNTRUSTED_COMPONENTS : readmeComponents(resolveImage)), [untrusted, resolveImage]);
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={untrusted ? undefined : README_REHYPE_PLUGINS}
        components={components}
        skipHtml={untrusted}
      >
        {children}
      </Markdown>
    </div>
  );
}
