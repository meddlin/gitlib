import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  clean: true,
  // @gitlib/core is a private workspace package, so inline it into the published CLI.
  noExternal: ["@gitlib/core"],
});
