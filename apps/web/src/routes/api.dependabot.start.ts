import { createFileRoute } from "@tanstack/react-router";

// Called once by `server.mjs` when the production server starts, so the schedule runs (and catches up on a slot missed
// while the server was down) and the notes get written without anyone opening a page. Starting twice does nothing.
// See api.chat.ts for why `server` is written out here and why the directive below is needed.
export const Route = createFileRoute("/api/dependabot/start")({
  // @ts-expect-error
  server: {
    handlers: {
      POST: async (): Promise<Response> => {
        const { ensureBackground } = await import("../server/dependabot.server");
        ensureBackground();
        return new Response(null, { status: 204 });
      },
    },
  },
});
