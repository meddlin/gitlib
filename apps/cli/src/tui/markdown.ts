import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";

/** Renders Markdown to ANSI-styled terminal lines, falling back to the raw text. */
export function renderMarkdownLines(markdown: string, width: number): string[] {
  let rendered: string;
  try {
    const marked = new Marked(markedTerminal({ width, reflowText: true, tab: 2 }) as never);
    rendered = marked.parse(markdown, { async: false });
  } catch {
    rendered = markdown;
  }
  const lines = rendered.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines;
}
