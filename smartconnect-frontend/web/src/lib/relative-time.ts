const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "now", "5 min. ago", "3 hr. ago", "yesterday", then a date after a week. */
export function formatRelative(iso: string, now = Date.now()): string {
  const elapsed = now - new Date(iso).getTime();
  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return relative.format(-Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return relative.format(-Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 7 * DAY) return relative.format(-Math.floor(elapsed / DAY), 'day');
  return date.format(new Date(iso));
}
