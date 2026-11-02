const dateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
export const formatDate = (iso: string) => dateFormat.format(new Date(iso));

/** Label colors come from GitHub; only a plain hex value is ever used in a style. */
export const labelColor = (color: string) => (/^[0-9a-f]{6}$/i.test(color) ? `#${color}` : "#888888");

/** "just now", "5 min ago", "3 h ago", "2 days ago"; empty for an unreadable timestamp. */
export function formatAgo(iso: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}
