/**
 * Screen geometry shared by the view (what is drawn where) and the model (what a click hits).
 * Everything is in terminal cells, zero-based, with the UI filling the whole screen.
 */

export const SUMMARY_LINES = 8;
export const REMOTE_LINES = 7;
export const NOTES_LINES = 4;
/** Labels + fixed-height sections inside the detail pane (everything but the README body). */
const DETAIL_FIXED_LINES = SUMMARY_LINES + REMOTE_LINES + NOTES_LINES + 3;
/** Header, filter bar, status line and footer. */
const CHROME_LINES = 4;

export const SEARCH_LABEL = "Search: ";
export const TECHNOLOGY_LABEL = "Technology: ";
export const FILTER_VALUE_WIDTH = 20;
const FIELD_GAP = 2;
const NOTES_ONLY_LABEL = "[ ] Notes only";
const WORKTREES_LABEL = "[ ] Worktrees";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FooterAction =
  | "refresh"
  | "search"
  | "worktrees"
  | "edit"
  | "vscode"
  | "remote"
  | "save"
  | "cancel"
  | "quit";

export const FOOTER_BUTTONS: { action: FooterAction; key: string; name: string }[] = [
  { action: "refresh", key: "r", name: "Refresh" },
  { action: "search", key: "/", name: "Search" },
  { action: "worktrees", key: "w", name: "Worktrees" },
  { action: "edit", key: "e", name: "Edit" },
  { action: "vscode", key: "v", name: "VS Code" },
  { action: "remote", key: "o", name: "Open Remote" },
  { action: "save", key: "^S", name: "Save" },
  { action: "cancel", key: "Esc", name: "Cancel" },
  { action: "quit", key: "q", name: "Quit" },
];
export const FOOTER_GAP = 2;

export interface Layout {
  columns: number;
  rows: number;
  contentHeight: number;
  leftWidth: number;
  rightWidth: number;
  detailInnerWidth: number;
  readmeHeight: number;
  tableHeight: number;

  search: Rect;
  technology: Rect;
  notesOnly: Rect;
  worktrees: Rect;
  /** The whole left (repository list) pane, borders included. */
  tablePane: Rect;
  /** The data rows of the repository table. */
  tableRows: Rect;
  /** The whole right (detail) pane, borders included. */
  detailPane: Rect;
  notes: Rect;
  readme: Rect;
  statusY: number;
  footer: { action: FooterAction; rect: Rect }[];
}

export function computeLayout(columns: number, rows: number): Layout {
  const contentHeight = Math.max(8, rows - CHROME_LINES);
  const leftWidth = Math.floor(columns * 0.6);
  const rightWidth = columns - leftWidth;
  const readmeHeight = Math.max(3, contentHeight - 2 - DETAIL_FIXED_LINES);
  const tableHeight = Math.max(1, contentHeight - 4);

  const filterY = 1;
  const contentY = 2;

  // Filter bar: 1 cell of padding, then fixed-width fields so clicks map predictably.
  const searchWidth = SEARCH_LABEL.length + FILTER_VALUE_WIDTH;
  const technologyWidth = TECHNOLOGY_LABEL.length + FILTER_VALUE_WIDTH;
  const search: Rect = { x: 1, y: filterY, width: searchWidth, height: 1 };
  const technology: Rect = {
    x: search.x + searchWidth + FIELD_GAP,
    y: filterY,
    width: technologyWidth,
    height: 1,
  };
  const notesOnly: Rect = {
    x: technology.x + technologyWidth + FIELD_GAP,
    y: filterY,
    width: NOTES_ONLY_LABEL.length,
    height: 1,
  };

  const worktrees: Rect = {
    x: notesOnly.x + NOTES_ONLY_LABEL.length + FIELD_GAP,
    y: filterY,
    width: WORKTREES_LABEL.length,
    height: 1,
  };

  // Detail pane: border (1) + padding (1) on each side, then stacked sections.
  const detailX = leftWidth + 2;
  const detailTop = contentY + 1;
  const notesY = detailTop + SUMMARY_LINES + 1 + REMOTE_LINES + 1;
  const readmeY = notesY + NOTES_LINES + 1;
  const detailInnerWidth = Math.max(10, rightWidth - 4);

  const statusY = contentY + contentHeight;
  const footerY = statusY + 1;
  let footerX = 1;
  const footer = FOOTER_BUTTONS.map(({ action, key, name }) => {
    const width = key.length + 1 + name.length;
    const rect: Rect = { x: footerX, y: footerY, width, height: 1 };
    footerX += width + FOOTER_GAP;
    return { action, rect };
  });

  return {
    columns,
    rows,
    contentHeight,
    leftWidth,
    rightWidth,
    detailInnerWidth,
    readmeHeight,
    tableHeight,
    search,
    technology,
    notesOnly,
    worktrees,
    tablePane: { x: 0, y: contentY, width: leftWidth, height: contentHeight },
    // border (1) + title line + column header line
    tableRows: { x: 2, y: contentY + 3, width: Math.max(1, leftWidth - 4), height: tableHeight },
    detailPane: { x: leftWidth, y: contentY, width: rightWidth, height: contentHeight },
    notes: { x: detailX, y: notesY, width: detailInnerWidth, height: NOTES_LINES },
    // Includes the "README.md" label row so clicking the title focuses the pane too.
    readme: { x: detailX, y: readmeY - 1, width: detailInnerWidth, height: readmeHeight + 1 },
    statusY,
    footer,
  };
}

export function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** First visible notes row so the cursor row stays on screen while editing. */
export function notesWindowStart(cursorRow: number): number {
  return cursorRow >= NOTES_LINES ? cursorRow - NOTES_LINES + 1 : 0;
}

/** Scrolls a single-line field so the cursor stays visible; returns the visible slice. */
export function windowForCursor(
  value: string,
  cursor: number,
  width: number,
): { start: number; text: string; column: number } {
  // Reserve one cell for the cursor block when it sits after the last character.
  const start = cursor >= width ? cursor - width + 1 : 0;
  return { start, text: value.slice(start, start + width), column: cursor - start };
}
