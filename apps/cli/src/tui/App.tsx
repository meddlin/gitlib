import { Box, Text, useApp, useInput, useStdin, useStdout, useWindowSize } from "ink";
import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { formatRemoteTargets, formatRepoSummary } from "./format.js";
import {
  FILTER_VALUE_WIDTH,
  FOOTER_BUTTONS,
  FOOTER_GAP,
  NOTES_LINES,
  REMOTE_LINES,
  SEARCH_LABEL,
  SUMMARY_LINES,
  TECHNOLOGY_LABEL,
  computeLayout,
  notesWindowStart,
  windowForCursor,
} from "./layout.js";
import { renderMarkdownLines } from "./markdown.js";
import { DISABLE_MOUSE, ENABLE_MOUSE, parseMouseEvents } from "./mouse.js";
import type { TuiModel } from "./model.js";
import type { TextBuffer } from "./text-buffer.js";

export interface TuiSize {
  columns: number;
  rows: number;
}

const truncate = (text: string, width: number): string =>
  text.length <= width ? text : width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;

function fitColumns(natural: number[], total: number, gap: number): number[] {
  const widths = [...natural];
  const available = Math.max(total - gap * (widths.length - 1), widths.length * 4);
  while (widths.reduce((sum, width) => sum + width, 0) > available) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 4) break;
    widths[widest] = widths[widest]! - 1;
  }
  return widths;
}

function Cursor({ text, column, active }: { text: string; column: number; active: boolean }) {
  if (!active) return <Text>{text}</Text>;
  const before = text.slice(0, column);
  const under = text.slice(column, column + 1) || " ";
  const after = text.slice(column + 1);
  return (
    <Text>
      {before}
      <Text inverse>{under}</Text>
      {after}
    </Text>
  );
}

function InputField({
  label,
  placeholder,
  buffer,
  focused,
}: {
  label: string;
  placeholder: string;
  buffer: TextBuffer;
  focused: boolean;
}) {
  const view = windowForCursor(buffer.value, buffer.cursor, FILTER_VALUE_WIDTH);
  return (
    <Box width={label.length + FILTER_VALUE_WIDTH} marginRight={2}>
      <Text color={focused ? "cyan" : undefined}>{label}</Text>
      {buffer.value === "" && !focused ? (
        <Text dimColor>{truncate(placeholder, FILTER_VALUE_WIDTH)}</Text>
      ) : (
        <Cursor text={view.text} column={view.column} active={focused} />
      )}
    </Box>
  );
}

function NotesView({ model, focused }: { model: TuiModel; focused: boolean }) {
  const lines = model.displayedNotes.split("\n");
  const position = model.editMode ? model.notes.position() : { row: 0, column: 0 };
  const start = model.editMode ? notesWindowStart(position.row) : 0;

  return (
    <Box flexDirection="column" height={NOTES_LINES} overflow="hidden">
      {Array.from({ length: NOTES_LINES }, (_, offset) => {
        const row = start + offset;
        const active = focused && model.editMode && row === position.row;
        return (
          <Text key={offset} wrap="truncate-end">
            <Cursor text={lines[row] ?? ""} column={position.column} active={active} />
          </Text>
        );
      })}
    </Box>
  );
}

/** Turns on terminal mouse reporting and forwards clicks and wheel events to the model. */
function useMouse(model: TuiModel, enabled: boolean): void {
  const { stdin } = useStdin();
  const { stdout } = useStdout();

  useEffect(() => {
    if (!enabled) return;

    // Ink consumes mouse reports (it drops sequences it cannot map to a key), so we listen
    // alongside it: stdin.read() also emits "data", letting both see every chunk.
    const onData = (chunk: string | Buffer) => {
      for (const event of parseMouseEvents(chunk.toString())) model.handleMouse(event);
    };
    stdin.on("data", onData);
    stdout.write(ENABLE_MOUSE);

    // Always hand the terminal back with mouse reporting off, even on abrupt exits.
    const restore = () => void stdout.write(DISABLE_MOUSE);
    process.once("exit", restore);

    return () => {
      stdin.off("data", onData);
      process.off("exit", restore);
      restore();
    };
  }, [enabled, model, stdin, stdout]);
}

export function GitLibTui({
  model,
  size,
  mouse = true,
}: {
  model: TuiModel;
  size?: TuiSize;
  mouse?: boolean;
}) {
  useSyncExternalStore(model.subscribe, model.getVersion);
  const { exit } = useApp();
  const windowSize = useWindowSize();
  const { columns, rows } = size ?? windowSize;

  useInput((input, key) => model.handleInput(input, key));
  useMouse(model, mouse);

  useEffect(() => {
    if (model.didRequestExit) exit();
  });

  const layout = computeLayout(columns, rows);
  model.setLayout(layout);
  const { contentHeight, leftWidth, rightWidth, readmeHeight, tableHeight, detailInnerWidth } = layout;

  const offset = model.syncTableOffset();
  const headers = ["repo", "relative_path", "technologies", "notes"];
  const tableRows = model.filteredRepositories.map((repo) => [
    repo.name,
    repo.relativePath,
    repo.technologies.length > 0 ? repo.technologies.join(", ") : "-",
    repo.hasNotes ? "yes" : "-",
  ]);
  const natural = headers.map((header, index) =>
    Math.max(header.length, ...tableRows.map((row) => row[index]!.length)),
  );
  const widths = fitColumns(natural, layout.tableRows.width, 2);
  const formatRow = (cells: string[]) =>
    cells.map((cell, index) => truncate(cell, widths[index]!).padEnd(widths[index]!)).join("  ");

  const readmeText = model.readmeText;
  const readmeLines = useMemo(
    () => renderMarkdownLines(readmeText, detailInnerWidth),
    [readmeText, detailInnerWidth],
  );
  model.setReadmeViewport(readmeLines.length, readmeHeight);
  const readmeScroll = model.readmeScroll;
  const readmeVisible = readmeLines.slice(readmeScroll, readmeScroll + readmeHeight);

  const summaryLines = formatRepoSummary(model.details).split("\n");
  const remoteLines = formatRemoteTargets(model.details).split("\n");

  const focused = model.focus;
  const labelColor = (target: typeof focused) => (focused === target ? "cyan" : undefined);
  const lines = (items: string[], height: number, wrap: "wrap" | "truncate-end"): ReactNode => (
    <Box flexDirection="column" height={height} overflow="hidden">
      {items.map((line, index) => (
        <Text key={index} wrap={wrap}>
          {line || " "}
        </Text>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box>
        <Text bold inverse>
          {" gitlib "}
        </Text>
        <Text dimColor>
          {" "}
          {model.filteredRepositories.length} of {model.scopeCount} repositories
        </Text>
      </Box>

      <Box paddingX={1}>
        <InputField label={SEARCH_LABEL} placeholder="Search repos" buffer={model.search} focused={focused === "search"} />
        <InputField
          label={TECHNOLOGY_LABEL}
          placeholder="Technology tag"
          buffer={model.technology}
          focused={focused === "technology"}
        />
        <Text color={labelColor("notes-only")} inverse={focused === "notes-only"}>
          [{model.notesOnly ? "x" : " "}] Notes only
        </Text>
        <Box marginLeft={2}>
          <Text color={labelColor("worktrees")} inverse={focused === "worktrees"}>
            [{model.showWorktrees ? "x" : " "}] Worktrees
          </Text>
        </Box>
      </Box>

      <Box height={contentHeight}>
        <Box
          flexDirection="column"
          width={leftWidth}
          borderStyle="round"
          borderColor={focused === "table" ? "cyan" : "gray"}
          paddingX={1}
        >
          <Text bold>Repositories</Text>
          <Text dimColor>{formatRow(headers)}</Text>
          {tableRows.length === 0 ? (
            <Text dimColor>No repositories match.</Text>
          ) : (
            tableRows.slice(offset, offset + tableHeight).map((row, index) => (
              <Text key={offset + index} inverse={offset + index === model.cursor} wrap="truncate-end">
                {formatRow(row)}
              </Text>
            ))
          )}
        </Box>

        <Box
          flexDirection="column"
          width={rightWidth}
          borderStyle="round"
          borderColor={focused === "readme" || focused === "notes" ? "cyan" : "gray"}
          paddingX={1}
        >
          {lines(summaryLines, SUMMARY_LINES, "wrap")}
          <Text bold>Remote Targets</Text>
          {lines(remoteLines, REMOTE_LINES, "wrap")}
          <Text bold color={labelColor("notes")}>
            Notes{model.editMode ? " (editing)" : ""}
          </Text>
          <NotesView model={model} focused={focused === "notes"} />
          <Text bold color={labelColor("readme")}>
            README.md
            {readmeLines.length > readmeHeight
              ? ` (${readmeScroll + 1}-${Math.min(readmeScroll + readmeHeight, readmeLines.length)}/${readmeLines.length})`
              : ""}
          </Text>
          {lines(readmeVisible, readmeHeight, "truncate-end")}
        </Box>
      </Box>

      <Box paddingX={1}>
        <Text wrap="truncate-end">{model.status}</Text>
      </Box>
      <Box paddingX={1}>
        {FOOTER_BUTTONS.map(({ action, key, name }, index) => (
          <Text key={action} dimColor={action === "save" || action === "cancel" ? !model.editMode : false}>
            {index > 0 ? " ".repeat(FOOTER_GAP) : ""}
            <Text bold color="cyan">
              {key}
            </Text>{" "}
            {name}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
