import type { TextSegment } from "./types.js";

// Private-use code points: they cannot appear in real text, and unlike "<mark>" they can never be
// mistaken for (or injected as) markup, so callers render matches however they like.
export const HIGHLIGHT_START = "";
export const HIGHLIGHT_END = "";

/** Splits marker-wrapped text into segments. Returns null when nothing in `raw` matched. */
export function parseHighlights(raw: string): TextSegment[] | null {
  if (!raw.includes(HIGHLIGHT_START)) return null;

  const segments: TextSegment[] = [];
  let match = false;
  let buffer = "";
  const flush = () => {
    if (buffer) segments.push({ text: buffer, match });
    buffer = "";
  };

  for (const char of raw) {
    if (char === HIGHLIGHT_START) {
      flush();
      match = true;
    } else if (char === HIGHLIGHT_END) {
      flush();
      match = false;
    } else {
      buffer += char;
    }
  }
  flush();
  return segments;
}

/** Renders segments as a string, passing each matched run through `wrap`. */
export function renderSegments(
  segments: readonly TextSegment[],
  wrap: (text: string) => string = (text) => `«${text}»`,
): string {
  return segments.map((segment) => (segment.match ? wrap(segment.text) : segment.text)).join("");
}
