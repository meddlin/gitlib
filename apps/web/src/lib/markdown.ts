import { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";

/**
 * Attributes any allowed element may carry: presentation (`align`, `width`, `height`), table layout and a few
 * content hints. Nothing here runs code or loads anything. `id` and `name` stay because the sanitizer prefixes them
 * with `user-content-`, so a README can't shadow an id the page itself uses.
 */
const GLOBAL_ATTRIBUTES = [
  "align",
  "alt",
  "checked",
  "colSpan",
  "dateTime",
  "dir",
  "height",
  "id",
  "lang",
  "name",
  "open",
  "rowSpan",
  "scope",
  "span",
  "start",
  "title",
  "vAlign",
  "width",
];

/** Elements dropped together with their contents, so a `<style>` block's CSS is not printed as text. */
const STRIPPED_WITH_CONTENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "title",
  "iframe",
  "object",
  "embed",
  "textarea",
  "svg",
  "math",
];

/**
 * What raw HTML in a README may be: GitHub's own list (headings, `p`/`div` with `align`, `img`, `a`, tables,
 * `details`/`summary`, `kbd`, `sub`/`sup`, ...) minus `source`. A `<picture>` therefore shows its `<img>`, so there is
 * no second image address (`srcset`) to vet. Event handlers, `style`, `class`, forms, frames and scripts are not in
 * it; `href` and `src` are limited to http(s) here and again by the link and image renderers.
 */
export const README_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => tag !== "source"),
  strip: STRIPPED_WITH_CONTENTS,
  attributes: { ...defaultSchema.attributes, "*": GLOBAL_ATTRIBUTES },
  // The sanitizer turns any <input> it keeps into a disabled checkbox. That is right for a task list item and
  // pointless anywhere else, so a stray <input> in a README is dropped instead of becoming a lone checkbox.
  ancestors: { ...defaultSchema.ancestors, input: ["li"] },
};

/** Only absolute http(s) URLs are live; relative ones point into a repo on disk, which the browser can't reach. */
export const isRemoteUrl = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);

/**
 * An `<img width>`/`height` worth passing on: a pixel count or a percentage, never anything else. The value comes
 * from a README, so it is parsed rather than trusted.
 */
export function imageDimension(value: unknown): number | string | undefined {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 && value <= 10_000 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^(\d{1,5})(px|%)?$/.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (amount <= 0 || (match[2] === "%" && amount > 100) || (match[2] !== "%" && amount > 10_000)) return undefined;
  return match[2] === "%" ? `${amount}%` : amount;
}

/** Where a README-relative image can be fetched from, or null for none. Must return an http(s) URL or a same-origin path. */
export type ImageResolver = (src: string) => string | null;

/** A resolver's answer is only used if it is an absolute http(s) URL or a same-origin path (not `//host`). */
export function usableImageUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return isRemoteUrl(url) || /^\/(?!\/)/.test(url) ? url : null;
}
