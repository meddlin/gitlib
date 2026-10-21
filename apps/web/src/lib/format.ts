const dateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });
export const formatDate = (iso: string) => dateFormat.format(new Date(iso));

/** Label colors come from GitHub; only a plain hex value is ever used in a style. */
export const labelColor = (color: string) => (/^[0-9a-f]{6}$/i.test(color) ? `#${color}` : "#888888");
