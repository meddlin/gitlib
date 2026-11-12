/** Picking and describing READMEs; pure, so the server and the tests share it. */

/** Keeps a pathological README from bloating the response. */
export const MAX_README_LENGTH = 500_000;

/** A README fetched from GitHub or GitLab. */
export interface RemoteReadme {
  /** The file's name on the host (`README.md`); null when the repository has none. */
  fileName: string | null;
  /** The text, when the file is Markdown; null when there is no README or it is in another format. */
  markdown: string | null;
  error: string | null;
}

/** A repository with no README: not an error. */
export const NO_README: RemoteReadme = Object.freeze({ fileName: null, markdown: null, error: null });

const README_NAME = /^readme(\.[a-z0-9]+)?$/i;
const MARKDOWN_EXTENSION = /\.(md|markdown|mdown|mkd)$/i;

export const isMarkdownFileName = (name: string): boolean => MARKDOWN_EXTENSION.test(name);

/**
 * The README among a directory's file names, or null if there is none. Markdown wins over other formats
 * (`README.md` over `readme.md` over `README.markdown`), so a repo with `README.rst` and `README.md` shows the latter.
 */
export function pickReadmeName(names: readonly string[]): string | null {
  const rank = (name: string): number =>
    name === "README.md" ? 0 : name.toLowerCase() === "readme.md" ? 1 : isMarkdownFileName(name) ? 2 : 3;
  const candidates = names.filter((name) => README_NAME.test(name));
  return candidates.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0] ?? null;
}
