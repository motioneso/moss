const MAX_ATTENDEE_NAMES = 20;
const MAX_NAME_LENGTH = 80;

/**
 * Display names of a Google event's attendees. Drops the owner's own entry,
 * blanks, and anything that looks like an email address. Never returns emails.
 */
export function extractAttendeeNames(attendees: ReadonlyArray<unknown> | undefined): string[] {
  const names: string[] = [];
  for (const raw of attendees ?? []) {
    if (names.length >= MAX_ATTENDEE_NAMES) break;
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as { displayName?: unknown; self?: unknown };
    if (entry.self === true || typeof entry.displayName !== "string") continue;
    const name = entry.displayName.trim().slice(0, MAX_NAME_LENGTH).trim();
    if (name === "" || name.includes("@")) continue;
    names.push(name);
  }
  return names;
}

/** Event metadata for the attendee list: the count plus display names (no emails). */
export function attendeeMetadata(attendees: ReadonlyArray<unknown> | undefined) {
  return {
    attendeeCount: attendees?.length ?? 0,
    attendeeNames: extractAttendeeNames(attendees)
  };
}
