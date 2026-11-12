import { createFileRoute } from "@tanstack/react-router";

// Serves the images a local README refers to by relative path. A plain HTTP route (not a server function) so the
// browser can load it from an <img>. See api.chat.ts for why `server` is written out here and why the directive
// below is needed.
export const Route = createFileRoute("/api/repo-asset")({
  // @ts-expect-error
  server: {
    handlers: {
      GET: async ({ request }: { request: Request }): Promise<Response> => {
        const { handleRepoAsset } = await import("../server/repo-asset.server");
        return handleRepoAsset(request);
      },
    },
  },
});
