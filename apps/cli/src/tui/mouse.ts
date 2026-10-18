/** Terminal mouse reporting: press/release + wheel (1000) in SGR encoding (1006). */
export const ENABLE_MOUSE = "\u001B[?1000h\u001B[?1006h";
export const DISABLE_MOUSE = "\u001B[?1000l\u001B[?1006l";

export interface MouseEvent {
  kind: "press" | "release" | "wheel";
  button: "left" | "middle" | "right" | "none";
  /** Only set for wheel events. */
  direction?: "up" | "down";
  /** Zero-based terminal cell. */
  x: number;
  y: number;
}

// ESC [ < button ; column ; row (M = press, m = release)
// eslint-disable-next-line no-control-regex
const SGR_MOUSE = /\u001B\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Extracts every SGR mouse report from a chunk of terminal input. */
export function parseMouseEvents(chunk: string): MouseEvent[] {
  const events: MouseEvent[] = [];
  for (const match of chunk.matchAll(SGR_MOUSE)) {
    const code = Number(match[1]);
    const x = Number(match[2]) - 1;
    const y = Number(match[3]) - 1;
    const isRelease = match[4] === "m";

    // Bit 5 marks motion, which we never request; ignore it if a terminal sends it anyway.
    if (code & 32) continue;

    if (code & 64) {
      // Wheel: 64 up, 65 down, 66/67 horizontal (ignored).
      const wheel = code & 3;
      if (wheel === 0 || wheel === 1) {
        events.push({ kind: "wheel", button: "none", direction: wheel === 0 ? "up" : "down", x, y });
      }
      continue;
    }

    const button = (["left", "middle", "right"] as const)[code & 3] ?? "none";
    events.push({ kind: isRelease ? "release" : "press", button, x, y });
  }
  return events;
}
