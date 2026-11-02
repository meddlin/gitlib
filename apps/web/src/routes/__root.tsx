import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ChatPanel } from "#/components/chat-panel";
import { NavBar } from "#/components/nav-bar";
import { THEME_SCRIPT, useThemeSync } from "#/lib/themes";
import { cn } from "#/lib/utils";
import appCss from "../styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Gitlib" },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
});

function RootComponent() {
  useThemeSync();
  // The chat lives here, above the routes, so a conversation survives moving between pages.
  const [chatOpen, setChatOpen] = useState(false);
  return (
    // On wide screens the page makes room for the panel (28rem, as wide as it is) instead of hiding behind it.
    <div className={cn("flex min-h-screen flex-col transition-[padding] duration-200", chatOpen && "lg:pr-[28rem]")}>
      <NavBar chatOpen={chatOpen} onToggleChat={() => setChatOpen((open) => !open)} />
      <Outlet />
      <ChatPanel open={chatOpen} onOpenChange={setChatOpen} />
    </div>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
