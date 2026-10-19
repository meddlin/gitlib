import {
  GitLibError,
  type GitLibApp,
  type RepoDetails,
  type RepoRecord,
} from "@gitlib/core";
import { formatReadme } from "./format.js";
import {
  FILTER_VALUE_WIDTH,
  SEARCH_LABEL,
  TECHNOLOGY_LABEL,
  contains,
  notesWindowStart,
  windowForCursor,
  type FooterAction,
  type Layout,
} from "./layout.js";
import type { MouseEvent } from "./mouse.js";
import { TextBuffer } from "./text-buffer.js";

export type FocusTarget = "table" | "readme" | "search" | "technology" | "notes-only" | "worktrees" | "notes";

/** The subset of Ink's `Key` that the model understands. */
export interface KeyPress {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
  return?: boolean;
  escape?: boolean;
  tab?: boolean;
  shift?: boolean;
  backspace?: boolean;
  delete?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

const TAB_ORDER: FocusTarget[] = [
  "table",
  "readme",
  "search",
  "technology",
  "notes-only",
  "worktrees",
];
const TEXT_FOCUS = new Set<FocusTarget>(["search", "technology", "notes"]);

/**
 * All TUI state and behaviour, independent of any rendering library. The Ink view
 * subscribes to it and forwards key presses; tests can drive it directly.
 */
export class TuiModel {
  repositories: RepoRecord[] = [];
  filteredRepositories: RepoRecord[] = [];
  selectedRelativePath: string | null = null;
  cursor = 0;
  details: RepoDetails | null = null;
  status = "Press r to scan repositories.";
  focus: FocusTarget = "table";
  editMode = false;
  didRequestExit = false;

  readonly search = new TextBuffer();
  readonly technology = new TextBuffer();
  notesOnly = false;
  /** Linked git worktrees are hidden until toggled on. */
  showWorktrees = false;
  notes = new TextBuffer();

  readmeScroll = 0;
  /** Reported by the view so scrolling can be clamped. */
  readmeLineCount = 0;
  readmeViewHeight = 10;
  tableViewHeight = 10;
  tableOffset = 0;
  /** Set by the view each render; mouse clicks are hit-tested against it. */
  layout: Layout | null = null;

  private readonly cache = new Map<string, RepoDetails>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  constructor(readonly gitlib: GitLibApp) {}

  // --- subscription (useSyncExternalStore) ---------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private changed(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  // --- derived state --------------------------------------------------------

  get selectedRepository(): RepoRecord | null {
    if (this.selectedRelativePath === null) return null;
    return this.repositories.find((repo) => repo.relativePath === this.selectedRelativePath) ?? null;
  }

  /** Repositories in scope for the "N of M" header: hidden worktrees are not counted. */
  get scopeCount(): number {
    return this.showWorktrees
      ? this.repositories.length
      : this.repositories.filter((repo) => !repo.isWorktree).length;
  }

  get readmeText(): string {
    return formatReadme(this.details);
  }

  /** Notes shown in the detail pane: the live draft while editing, else the saved notes. */
  get displayedNotes(): string {
    if (this.editMode) return this.notes.value;
    return this.details?.repo.notes ?? "";
  }

  setStatus(message: string): void {
    this.status = message;
  }

  setReadmeViewport(lineCount: number, height: number): void {
    this.readmeLineCount = lineCount;
    this.readmeViewHeight = height;
    this.readmeScroll = Math.min(this.readmeScroll, this.maxReadmeScroll());
  }

  setLayout(layout: Layout): void {
    this.layout = layout;
    this.tableViewHeight = Math.max(1, layout.tableHeight);
  }

  /** First visible table row, adjusted so the cursor stays in view. */
  syncTableOffset(): number {
    const height = this.tableViewHeight;
    let offset = this.tableOffset;
    if (this.cursor < offset) offset = this.cursor;
    if (this.cursor >= offset + height) offset = this.cursor - height + 1;
    this.tableOffset = Math.max(0, Math.min(offset, Math.max(0, this.filteredRepositories.length - height)));
    return this.tableOffset;
  }

  private maxReadmeScroll(): number {
    return Math.max(0, this.readmeLineCount - this.readmeViewHeight);
  }

  // --- data ------------------------------------------------------------------

  start(): void {
    this.refreshData(true);
    this.changed();
  }

  private refreshData(initial = false): void {
    if (this.editMode && !initial) {
      this.setStatus("Save or cancel note edits before refreshing.");
      return;
    }

    const preserved = this.selectedRelativePath;
    try {
      this.repositories = this.gitlib.refresh();
    } catch (error) {
      if (!(error instanceof GitLibError)) throw error;
      this.setStatus(`Refresh failed: ${error.message}`);
      return;
    }

    this.cache.clear();
    this.rebuild(preserved);
    const count = this.filteredRepositories.length;
    const summary = initial ? `Loaded ${count} repositories.` : `Refreshed ${count} repositories.`;
    const remoteError = this.details?.remoteError;
    this.setStatus(remoteError ? `${summary} Remotes unavailable: ${remoteError}` : summary);
  }

  private reloadCachedData(preferred: string | null): void {
    this.repositories = this.gitlib.loadRepositories();
    this.cache.clear();
    this.rebuild(preferred ?? this.selectedRelativePath);
  }

  private rebuild(preferred: string | null): void {
    this.filteredRepositories = this.gitlib.filterRepositories(this.repositories, {
      search: this.search.value.trim(),
      technology: this.technology.value.trim(),
      notesOnly: this.notesOnly,
      includeWorktrees: this.showWorktrees,
    });

    if (this.filteredRepositories.length === 0) {
      this.cursor = 0;
      this.showRepository(null);
      return;
    }

    const index = this.filteredRepositories.findIndex((repo) => repo.relativePath === preferred);
    this.cursor = index === -1 ? 0 : index;
    this.showRepository(this.filteredRepositories[this.cursor]!);
  }

  private detailsFor(repo: RepoRecord): RepoDetails {
    const cached = this.cache.get(repo.relativePath);
    if (cached && cached.repo.notes === repo.notes) return cached;

    const details = this.gitlib.getRepositoryDetails(repo.relativePath, false);
    this.cache.set(repo.relativePath, details);
    return details;
  }

  private showRepository(repo: RepoRecord | null): void {
    this.readmeScroll = 0;
    if (repo === null) {
      this.selectedRelativePath = null;
      this.details = null;
      return;
    }

    this.selectedRelativePath = repo.relativePath;
    this.details = this.detailsFor(repo);
    this.setStatus(
      this.details.remoteError
        ? `Selected ${repo.relativePath}. Remotes unavailable: ${this.details.remoteError}`
        : `Selected ${repo.relativePath}.`,
    );
  }

  private moveCursor(target: number): void {
    if (this.filteredRepositories.length === 0) return;
    const next = Math.min(Math.max(target, 0), this.filteredRepositories.length - 1);
    if (next === this.cursor) return;
    this.cursor = next;
    this.showRepository(this.filteredRepositories[next]!);
  }

  // --- actions ---------------------------------------------------------------

  quit(): void {
    this.didRequestExit = true;
  }

  refresh(): void {
    this.refreshData();
  }

  focusSearch(): void {
    this.focus = "search";
    this.setStatus("Search focused.");
  }

  editNotes(): void {
    const repo = this.selectedRepository;
    if (this.selectedRelativePath === null || repo === null) {
      this.setStatus("No repository selected.");
      return;
    }
    this.editMode = true;
    this.notes = new TextBuffer(this.details?.repo.notes ?? repo.notes);
    this.focus = "notes";
    this.setStatus("Editing notes. Press Ctrl+S to save or Esc to cancel.");
  }

  saveNotes(): void {
    if (!this.editMode || this.selectedRelativePath === null) {
      this.setStatus("No note edit in progress.");
      return;
    }

    let repo: RepoRecord;
    try {
      repo = this.gitlib.saveRepositoryNotes(this.selectedRelativePath, this.notes.value, false);
    } catch (error) {
      if (!(error instanceof GitLibError)) throw error;
      this.setStatus(`Save failed: ${error.message}`);
      return;
    }

    this.editMode = false;
    this.cache.delete(repo.relativePath);
    this.reloadCachedData(repo.relativePath);
    this.focus = "table";
    this.setStatus(`Saved notes for ${repo.relativePath}.`);
  }

  private cancelNoteEdit(): void {
    this.editMode = false;
    if (this.selectedRelativePath === null) {
      this.focus = "table";
      return;
    }

    let repo: RepoRecord;
    try {
      repo = this.gitlib.getRepository(this.selectedRelativePath, false);
    } catch (error) {
      if (!(error instanceof GitLibError)) throw error;
      this.setStatus(`Unable to reload notes: ${error.message}`);
      return;
    }

    this.cache.delete(repo.relativePath);
    this.showRepository(repo);
    this.focus = "table";
    this.setStatus(`Canceled note edits for ${repo.relativePath}.`);
  }

  openVscode(): void {
    const repo = this.selectedRepository;
    if (repo === null) {
      this.setStatus("No repository selected.");
      return;
    }
    try {
      const opened = this.gitlib.openRepositoryInVscode(repo.relativePath, false);
      this.setStatus(`Opened ${opened.relativePath} in VS Code.`);
    } catch (error) {
      if (!(error instanceof GitLibError)) throw error;
      this.setStatus(error.message);
    }
  }

  openRemote(): void {
    const repo = this.selectedRepository;
    if (repo === null) {
      this.setStatus("No repository selected.");
      return;
    }
    try {
      const { repo: opened, remote } = this.gitlib.openRepositoryRemote(repo.relativePath, false);
      this.setStatus(`Opened ${remote.name} for ${opened.relativePath}.`);
    } catch (error) {
      if (!(error instanceof GitLibError)) throw error;
      this.setStatus(error.message);
    }
  }

  escape(): void {
    if (this.editMode) {
      this.cancelNoteEdit();
      return;
    }
    if (this.focus !== "table") {
      this.focus = "table";
      this.setStatus("Focus returned to repository list.");
    }
  }

  cycleFocus(backwards: boolean): void {
    if (this.editMode) return;
    const index = TAB_ORDER.indexOf(this.focus);
    const step = backwards ? TAB_ORDER.length - 1 : 1;
    this.focus = TAB_ORDER[(index + step) % TAB_ORDER.length]!;
  }

  setNotesOnly(value: boolean): void {
    this.notesOnly = value;
    this.rebuild(this.selectedRelativePath);
  }

  setShowWorktrees(value: boolean): void {
    this.showWorktrees = value;
    this.rebuild(this.selectedRelativePath);
    this.setStatus(
      `${value ? "Showing" : "Hiding"} worktrees. ${this.filteredRepositories.length} repositories listed.`,
    );
  }

  // --- key handling ----------------------------------------------------------

  handleInput(input: string, key: KeyPress): void {
    this.dispatch(input, key);
    this.changed();
  }

  private dispatch(input: string, key: KeyPress): void {
    if (key.ctrl && input === "c") return this.quit();
    if (key.ctrl && input === "s") return this.saveNotes();
    if (key.escape) return this.escape();
    if (key.tab) return this.cycleFocus(Boolean(key.shift));

    if (this.focus === "notes") return this.handleTextInput(this.notes, input, key, true);
    if (this.focus === "search" || this.focus === "technology") {
      const buffer = this.focus === "search" ? this.search : this.technology;
      const before = buffer.value;
      this.handleTextInput(buffer, input, key, false);
      if (buffer.value !== before) this.rebuild(this.selectedRelativePath);
      return;
    }

    if (this.focus === "notes-only" && (input === " " || key.return)) {
      return this.setNotesOnly(!this.notesOnly);
    }
    if (this.focus === "worktrees" && (input === " " || key.return)) {
      return this.setShowWorktrees(!this.showWorktrees);
    }

    if (!key.ctrl && !key.meta) {
      switch (input) {
        case "q":
          return this.quit();
        case "r":
          return this.refresh();
        case "/":
          return this.focusSearch();
        case "e":
          return this.editNotes();
        case "v":
          return this.openVscode();
        case "o":
          return this.openRemote();
        case "w":
          return this.setShowWorktrees(!this.showWorktrees);
      }
    }

    if (this.focus === "table") this.handleTableKey(key);
    else if (this.focus === "readme") this.handleReadmeKey(key);
  }

  private handleTableKey(key: KeyPress): void {
    const page = Math.max(1, this.tableViewHeight - 1);
    if (key.upArrow) this.moveCursor(this.cursor - 1);
    else if (key.downArrow) this.moveCursor(this.cursor + 1);
    else if (key.pageUp) this.moveCursor(this.cursor - page);
    else if (key.pageDown) this.moveCursor(this.cursor + page);
    else if (key.home) this.moveCursor(0);
    else if (key.end) this.moveCursor(this.filteredRepositories.length - 1);
  }

  private handleReadmeKey(key: KeyPress): void {
    const page = Math.max(1, this.readmeViewHeight - 1);
    let next = this.readmeScroll;
    if (key.upArrow) next -= 1;
    else if (key.downArrow) next += 1;
    else if (key.pageUp) next -= page;
    else if (key.pageDown) next += page;
    else if (key.home) next = 0;
    else if (key.end) next = this.maxReadmeScroll();
    this.readmeScroll = Math.min(Math.max(next, 0), this.maxReadmeScroll());
  }

  private handleTextInput(buffer: TextBuffer, input: string, key: KeyPress, multiline: boolean): void {
    if (key.backspace || key.delete) buffer.backspace();
    else if (key.leftArrow) buffer.left();
    else if (key.rightArrow) buffer.right();
    else if (key.home) buffer.home();
    else if (key.end) buffer.end();
    else if (key.upArrow && multiline) buffer.up();
    else if (key.downArrow && multiline) buffer.down();
    else if (key.return && multiline) buffer.insert("\n");
    else if (input && !key.ctrl && !key.meta) {
      buffer.insert(multiline ? input.replace(/\r\n?/g, "\n") : input.replace(/[\r\n]+/g, " "));
    }
  }

  // --- mouse -------------------------------------------------------------------

  handleMouse(event: MouseEvent): void {
    this.dispatchMouse(event);
    this.changed();
  }

  private runFooterAction(action: FooterAction): void {
    switch (action) {
      case "refresh":
        return this.refresh();
      case "search":
        return this.editMode ? this.setStatus("Save or cancel note edits first.") : this.focusSearch();
      case "worktrees":
        return this.editMode ? this.setStatus("Save or cancel note edits first.") : this.setShowWorktrees(!this.showWorktrees);
      case "edit":
        return this.editMode ? undefined : this.editNotes();
      case "vscode":
        return this.openVscode();
      case "remote":
        return this.openRemote();
      case "save":
        return this.saveNotes();
      case "cancel":
        return this.escape();
      case "quit":
        return this.quit();
    }
  }

  private dispatchMouse(event: MouseEvent): void {
    const layout = this.layout;
    if (!layout) return;
    const { x, y } = event;

    if (event.kind === "wheel") return this.handleWheel(event, layout);
    if (event.kind !== "press" || event.button !== "left") return;

    const footerHit = layout.footer.find((button) => contains(button.rect, x, y));
    if (footerHit) return this.runFooterAction(footerHit.action);

    if (this.editMode) {
      if (contains(layout.notes, x, y)) this.placeNotesCursor(layout, x, y);
      else this.setStatus("Editing notes. Press Ctrl+S to save or Esc to cancel.");
      return;
    }

    if (contains(layout.search, x, y)) return this.clickField("search", layout.search.x + SEARCH_LABEL.length, x);
    if (contains(layout.technology, x, y)) {
      return this.clickField("technology", layout.technology.x + TECHNOLOGY_LABEL.length, x);
    }
    if (contains(layout.notesOnly, x, y)) {
      this.focus = "notes-only";
      return this.setNotesOnly(!this.notesOnly);
    }
    if (contains(layout.worktrees, x, y)) {
      this.focus = "worktrees";
      return this.setShowWorktrees(!this.showWorktrees);
    }

    if (contains(layout.tableRows, x, y)) {
      this.focus = "table";
      const index = this.tableOffset + (y - layout.tableRows.y);
      // Clicks on the empty area below the last row only focus the list.
      if (index < this.filteredRepositories.length) this.moveCursor(index);
      return;
    }
    if (contains(layout.tablePane, x, y)) {
      this.focus = "table";
      return;
    }

    if (contains(layout.notes, x, y)) {
      this.editNotes();
      if (this.editMode) this.placeNotesCursor(layout, x, y);
      return;
    }
    if (contains(layout.readme, x, y)) {
      this.focus = "readme";
      return;
    }
  }

  private clickField(target: "search" | "technology", valueX: number, x: number): void {
    this.focus = target;
    const buffer = target === "search" ? this.search : this.technology;
    const { start } = windowForCursor(buffer.value, buffer.cursor, FILTER_VALUE_WIDTH);
    buffer.cursor = Math.min(Math.max(start + (x - valueX), 0), buffer.value.length);
  }

  private placeNotesCursor(layout: Layout, x: number, y: number): void {
    const start = notesWindowStart(this.notes.position().row);
    this.notes.setPosition(start + (y - layout.notes.y), x - layout.notes.x);
  }

  private handleWheel(event: MouseEvent, layout: Layout): void {
    const step = event.direction === "up" ? -1 : 1;
    if (this.editMode) {
      if (contains(layout.notes, event.x, event.y)) {
        if (step < 0) this.notes.up();
        else this.notes.down();
      }
      return;
    }
    if (contains(layout.tablePane, event.x, event.y)) {
      this.moveCursor(this.cursor + step);
    } else if (contains(layout.readme, event.x, event.y)) {
      this.readmeScroll = Math.min(Math.max(this.readmeScroll + step * 3, 0), this.maxReadmeScroll());
    }
  }

  isTextFocus(): boolean {
    return TEXT_FOCUS.has(this.focus);
  }
}
