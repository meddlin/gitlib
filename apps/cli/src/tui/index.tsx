import type { GitLibApp } from "@gitlib/core";
import { render } from "ink";
import { GitLibTui } from "./App.js";
import { TuiModel } from "./model.js";

export { GitLibTui } from "./App.js";
export { TuiModel } from "./model.js";

export async function runTui(gitlib: GitLibApp): Promise<void> {
  const model = new TuiModel(gitlib);
  model.start();
  const instance = render(<GitLibTui model={model} />, {
    exitOnCtrlC: false,
    alternateScreen: true,
  });
  await instance.waitUntilExit();
}
