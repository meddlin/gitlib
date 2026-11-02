import { createFileRoute } from "@tanstack/react-router";

// A plain HTTP route, not a server function, so the reply can stream and the browser can cancel it. The build finds
// `server` by its shape in this object literal and strips it from the browser bundle, so keep it written out here.
export const Route = createFileRoute("/api/chat")({
  // Start adds the `server` option to route types by augmenting @tanstack/router-core, but this workspace installs
  // two patch versions of that package (react-router pins 1.171.38, Start 1.171.39), so the augmentation misses the
  // copy createFileRoute reads and the option is untyped. When `npm ls @tanstack/router-core` shows one copy this
  // directive becomes an error ("unused"), which is the cue to delete it.
  // @ts-expect-error
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }): Promise<Response> => {
        const { handleChat } = await import("../server/chat.server");
        return handleChat(request);
      },
    },
  },
});
