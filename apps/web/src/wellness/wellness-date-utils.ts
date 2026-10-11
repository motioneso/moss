import { localDay, moodIndex, type CheckinDto } from "@moss/shared";

/**
 * Count the consecutive-day streak ending yesterday (exclusive of today).
 *
 * Both the `seen` set and the backward walk use the SAME local-timezone calendar-date
 * strings (via the shared `localDay`) so UTC+12/+13/+14 users don't see a mismatch
 * between "today in Auckland" and the UTC date embedded in the stored timestamp.
 *
 * The backward walk uses pure calendar arithmetic (treating the local date as a UTC
 * date for subtraction) rather than a UTC-hour anchor, which would land on "tomorrow"
 * in far-east-of-UTC timezones and make i=1 return today instead of yesterday.
 */
export function computeStreak(checkins: readonly CheckinDto[], timeZone?: string): number {
  const seen = new Set<string>();
  checkins.forEach((c) => {
    const ts = c.checkedInAt ?? c.createdAt ?? "";
    if (ts) seen.add(localDay(ts, timeZone));
  });
  const todayStr = localDayOffset(0, timeZone);
  let s = 0;
  for (let i = 1; i <= 90; i++) {
    const iso = localDayOffset(i, timeZone, todayStr);
    if (seen.has(iso)) s++;
    else break;
  }
  return s;
}

export function localDayOffset(
  offsetDays: number,
  timeZone?: string,
  from: Date | string = new Date()
): string {
  const todayStr = typeof from === "string" ? from : localDay(from, timeZone);
  const [y, m, d] = todayStr.split("-").map(Number);
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  base.setUTCDate(base.getUTCDate() - offsetDays);
  return base.toISOString().slice(0, 10);
}

/** Average observed check-ins from the fourteen completed local calendar days. */
export function recentMoodAverage(
  checkins: readonly CheckinDto[],
  timeZone?: string,
  from: Date = new Date()
): number | null {
  const today = localDay(from, timeZone);
  const since = localDayOffset(14, timeZone, today);
  const recent = checkins.filter((checkin) => {
    const stamp = checkin.checkedInAt ?? checkin.createdAt;
    if (!stamp) return false;
    const day = localDay(stamp, timeZone);
    return day >= since && day < today;
  });
  if (recent.length === 0) return null;
  return (
    Math.round(
      (recent.reduce(
        (sum, checkin) => sum + moodIndex(checkin.feelingCore, checkin.intensity ?? 3),
        0
      ) /
        recent.length) *
        10
    ) / 10
  );
}
