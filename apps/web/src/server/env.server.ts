import fs from "node:fs";
import path from "node:path";

/**
 * Loads `.env.local` and `.env` into `process.env`, from the web app's working directory and then the
 * monorepo root. Variables already in the environment always win, and earlier files win over later
 * ones, so the order of precedence is: real environment > .env.local > .env, app dir > repo root.
 */
function loadEnvFiles(): void {
  const cwd = process.cwd();
  const dirs = [...new Set([cwd, path.resolve(cwd, "../..")])];
  for (const dir of dirs) {
    for (const name of [".env.local", ".env"]) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      try {
        process.loadEnvFile(file);
      } catch (error) {
        console.warn(`Could not read ${file}:`, error instanceof Error ? error.message : error);
      }
    }
  }
}

// Kept on globalThis so dev-server module reloads don't re-read the files.
const flag = globalThis as { __gitlibEnvLoaded?: boolean };
if (!flag.__gitlibEnvLoaded) {
  flag.__gitlibEnvLoaded = true;
  loadEnvFiles();
}
