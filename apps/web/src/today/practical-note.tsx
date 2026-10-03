import type { CalendarEventDto, LocaleSettingsDto } from "@moss/shared";

import { Note } from "@moss/ui";

import { ampm, timeLabel } from "./today-labels.js";

/** The next timed, not-yet-started event today that names a place, other than
    the meeting the First meeting card already shows. Null when nothing backs a
    note. Moss blocks are skipped because their location is not the person's. */
export function findPracticalEvent(
  events: readonly CalendarEventDto[],
  now: Date,
  excludeEventId: string | null
): CalendarEventDto | null {
  return (
    events.find(
      (event) =>
        !event.isMossBlock &&
        !event.allDay &&
        event.id !== excludeEventId &&
        event.location !== null &&
        event.location.trim() !== "" &&
        Date.parse(event.startsAt) > now.getTime()
    ) ?? null
  );
}

/** Morning side column note naming a later event's place and start time.
    States only what the calendar holds, so it never guesses a leave time.
    Renders nothing when no event backs it. */
export function PracticalNote(props: {
  readonly events: readonly CalendarEventDto[];
  readonly now: Date;
  readonly excludeEventId: string | null;
  readonly locale: LocaleSettingsDto;
}) {
  const event = findPracticalEvent(props.events, props.now, props.excludeEventId);
  if (!event) return null;
  const time = `${timeLabel(event.startsAt, props.locale)} ${ampm(event.startsAt, props.locale)}`;
  return (
    <Note variant="practical" className="cmd-practical" aria-label="A little practical context">
      <p>
        <strong>A little practical context</strong>
        {`${event.title} at ${time} is at ${event.location?.trim()}.`}
      </p>
    </Note>
  );
}
