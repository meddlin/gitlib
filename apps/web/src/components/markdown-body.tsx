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

// Text written by a model is shaped by whatever it was shown, including a hostile README, so it never loads an
// image (the browser would fetch the address, which can carry the conversation out) and shows where a link goes.
const UNTRUSTED_COMPONENTS: Components = {
  ...MARKDOWN_COMPONENTS,
  a: ({ href, children }) =>
    isRemote(href) ? (
      <a href={href} title={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => (alt ? <span className="text-muted-foreground">[image: {alt}]</span> : null),
};

/** Renders Markdown from a README or an issue body; `untrusted` is for text a model wrote. */
export function MarkdownBody({ children, untrusted = false }: { children: string; untrusted?: boolean }) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={untrusted ? UNTRUSTED_COMPONENTS : MARKDOWN_COMPONENTS} skipHtml>
        {children}
      </Markdown>
    </div>
  );
}
