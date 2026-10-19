import type { TextSegment } from "@gitlib/core";

/** Renders text with matched runs marked up as React nodes — never as HTML, so repo text can't inject markup. */
export function Highlighted({ segments, fallback }: { segments: TextSegment[] | undefined; fallback: string }) {
  if (!segments) return <>{fallback}</>;
  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark
            key={index}
            className="rounded-[3px] bg-yellow-200/80 px-0.5 text-foreground dark:bg-yellow-400/30"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
