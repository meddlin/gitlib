import { EventEmitter } from "node:events";
import { render } from "ink";
import type { ReactElement } from "react";

class FakeStdout extends EventEmitter {
  lastFrame = "";
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super();
  }
  write = (frame: string) => {
    // Mouse-mode toggles are control sequences, not rendered frames.
    if (frame.startsWith("\u001B[?")) return;
    this.lastFrame = frame;
  };
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  private data: string | null = null;
  write = (data: string) => {
    this.data = data;
    this.emit("readable");
    this.emit("data", data);
  };
  read = () => {
    const { data } = this;
    this.data = null;
    return data;
  };
  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}
}

/** Renders an Ink tree into in-memory streams of a chosen size. */
export function renderToFakeTerminal(tree: ReactElement, size: { columns: number; rows: number }) {
  const stdout = new FakeStdout(size.columns, size.rows);
  const stdin = new FakeStdin();
  const instance = render(tree, {
    stdout: stdout as never,
    stderr: new FakeStdout(size.columns, size.rows) as never,
    stdin: stdin as never,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    stdin,
    lastFrame: () => stdout.lastFrame,
    unmount: () => {
      instance.unmount();
      instance.cleanup();
    },
  };
}
