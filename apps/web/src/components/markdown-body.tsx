import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const isRemote = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);

// Only absolute http(s) links and images are live (a README's relative ones point into a repo on disk,
// which the browser can't reach). Raw HTML is dropped, never rendered.
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) =>
    isRemote(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt }) =>
    typeof src === "string" && isRemote(src) ? (
      <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />
    ) : alt ? (
      <span className="text-muted-foreground">[{alt}]</span>
    ) : null,
};

/** Renders Markdown from a README or an issue body. */
export function MarkdownBody({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS} skipHtml>
        {children}
      </Markdown>
    </div>
  );
}
