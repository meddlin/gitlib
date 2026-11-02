import { useEffect, useState } from "react";
import { formatAgo } from "#/lib/format";

/**
 * "5 min ago" for a timestamp; a time still to come is shown as the date. The server and the browser disagree about the time, so it renders the UTC time first
 * and switches to the relative form once mounted; the full time is in the tooltip.
 */
export function RelativeTime({ iso }: { iso: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const absolute = `${iso.slice(0, 16).replace("T", " ")} UTC`;
  return (
    <time dateTime={iso} title={absolute}>
      {now === null || Date.parse(iso) > now ? absolute : formatAgo(iso, now) || absolute}
    </time>
  );
}
