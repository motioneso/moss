# Medication recurrence patterns for #1349

**Date:** 2026-08-18  
**Issue:** [#1349 — Wellness Med Frequency](https://github.com/motioneso/moss/issues/1349)  
**Question:** Which recurrence patterns should Moss expose, and how can it keep medication scheduling
approachable while producing predictable reminders?

## Recommendation

Use a **progressive sentence builder backed by explicit recurrence fields**, not a raw RRULE editor
or a natural-language parser. Start with six choices—Daily, Selected days, Every interval, Monthly,
Cycle, and As needed—and reveal only the fields needed by the selected choice. Always show the
normalized sentence and the next three occurrences before Save.

This supports the requested examples without turning the form into a calendar-rule editor:

- `Daily at 9:00 AM and 9:00 PM`
- `Every Monday, Wednesday, and Friday at 8:00 AM`
- `Every 3 days at 9:00 AM, starting August 20`
- `Every 2 weeks on Tuesday at 9:00 AM, starting August 25`
- `Every month on the 15th at 9:00 AM`
- `Every month on the third Tuesday at 9:00 AM`
- `Every month on the last day at 9:00 AM`
- `21 days on, then 7 days off, starting August 20, at 9:00 AM`
- `As needed` (no generated occurrences)

Apple Health already separates frequency/duration from the schedule subtype and offers dedicated
“Every Few Days” and “On a Cyclical Schedule” choices. Todoist pairs common suggestions with a
Custom path and immediately renders the parsed recurrence. Those are good interaction patterns;
Moss does not need Todoist's free-text grammar.
[Apple Health medications](https://support.apple.com/guide/iphone/track-your-medications-iph811670c81/ios),
[Todoist recurring dates](https://www.todoist.com/help/articles/introduction-to-recurring-dates-YUYVJJAV)

## What the authoritative models establish

| Concern | Source model | Implication for Moss |
| --- | --- | --- |
| Frequency and interval | RFC 5545 defines secondly through yearly frequencies plus a positive `INTERVAL`; `DAILY;INTERVAL=8` means every eight days. [RFC 5545 §3.3.10](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10) | Store frequency and interval separately. Do not encode “every other day” as a special type. |
| Several doses in one period | FHIR `Timing.repeat` separates `frequency`, `period`, and `periodUnit`; its own example is “3 times per day.” It also has repeated `timeOfDay` values. [FHIR R5 Timing](https://hl7.org/fhir/R5/datatypes.html#Timing) | A recurrence selects eligible dates; an ordered list of local times creates that date's dose occurrences. |
| Selected weekdays | FHIR supplies repeated `dayOfWeek`; RFC supplies `BYDAY`. [FHIR R5 Timing](https://hl7.org/fhir/R5/datatypes.html#Timing), [RFC 5545 §3.3.10](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10) | Use weekday chips. For intervals greater than one week, require an anchor date so “every 2 weeks” is stable. |
| Day of month | RFC `BYMONTHDAY` accepts positive days and negative positions; Microsoft Graph calls a numbered date an `absoluteMonthly` pattern. [RFC 5545 §3.3.10](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10), [Microsoft Graph recurring events](https://learn.microsoft.com/en-us/graph/outlook-schedule-recurring-events#absolute-monthly-pattern) | Present 1–31 and **Last day** as distinct choices. Never silently turn the 31st into the month's last day. |
| Nth/last weekday | RFC permits positive and negative ordinal `BYDAY` values (`1MO`, `-1MO`); Microsoft Graph exposes first, second, third, fourth, and last weekday positions. [RFC 5545 §3.3.10](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10), [Microsoft Graph relative monthly pattern](https://learn.microsoft.com/en-us/graph/outlook-schedule-recurring-events#relative-monthly-pattern) | Support first through fourth and last weekday. “Third Tuesday” and “last Friday” are ordinary options, not advanced syntax. |
| Start and end | RFC supports inclusive `UNTIL`, occurrence `COUNT`, or no bound; Microsoft Graph likewise separates the recurrence pattern from numbered, end-date, and no-end ranges. [RFC 5545 §3.3.10](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10), [Microsoft Graph recurrence ranges](https://learn.microsoft.com/en-us/graph/outlook-schedule-recurring-events#recurrence-ranges) | Require a start date. Keep “No end” as the default, with optional end date; occurrence count can wait until a real request. |
| PRN / as needed | FHIR models `Dosage.asNeeded` separately from `Dosage.timing`, and Apple logs scheduled and “As Needed” medications in separate paths. [FHIR R5 Dosage](https://hl7.org/fhir/R5/dosage.html#Dosage), [Apple Health medications](https://support.apple.com/guide/iphone/track-your-medications-iph811670c81/ios) | PRN is a distinct mode. It must not manufacture due slots or missed reminders; it remains available for unscheduled logging. |
| Cycles | Apple offers a first-class cyclical medication schedule rather than forcing users to express one as a calendar recurrence. [Apple Health medications](https://support.apple.com/guide/iphone/track-your-medications-iph811670c81/ios) | Keep Moss's existing anchor + days-on + days-off model and apply the chosen dose times only on active days. Do not force cycles through RRULE. |
| Exceptions | RFC builds a recurrence set from the start and inclusion rules, then removes explicit `EXDATE` values; Google Calendar keeps a parent series and separately identifies moved/cancelled instances by their original start. [RFC 5545 §3.8.5.1](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.8.5.1), [Google Calendar recurring instances](https://developers.google.com/workspace/calendar/api/guides/recurringevents#accessing_instances) | A skipped/taken log is history, not a recurrence edit. If one-off schedule exceptions are later added, store them against the original occurrence identity. |

FHIR is useful as a vocabulary and interchange reference, but it is not a complete UX model for
monthly ordinals or rolling on/off cycles. RFC 5545 covers calendar expressiveness but is not itself
an appropriate user-facing contract. Moss should keep a small domain model and may translate it to
either standard later if an integration requires that.

## Recommended recurrence semantics

### Calendar patterns versus elapsed intervals

Make the distinction visible in the data model even if the UI wording stays simple:

- **Calendar-based:** daily, selected weekdays, every N days/weeks/months, day-of-month, and
  nth/last weekday. These stay anchored to the start date and selected local wall-clock times.
- **Elapsed-time:** every N hours. This advances from a start date-time by real elapsed duration,
  crosses midnight, and does not reset at civil midnight.

Todoist documents a similar important distinction between recurrence fixed to the original schedule
and recurrence calculated from completion/rescheduling. Medication scheduling should always use the
fixed form: logging late must not move future occurrences.
[Todoist recurring-date behavior](https://www.todoist.com/help/articles/introduction-to-recurring-dates-YUYVJJAV#reschedule-a-task-with-a-recurring-date)

An anchor is therefore required for every interval greater than one. It answers otherwise ambiguous
questions such as which weeks are “every other week” and where a 10-day cadence begins. Microsoft
Graph likewise requires a recurrence start date and notes that the first actual occurrence may be
later when the start does not match the pattern.
[Microsoft Graph recurrence ranges](https://learn.microsoft.com/en-us/graph/outlook-schedule-recurring-events#recurrence-ranges)

### Monthly edge cases

Use these explicit rules and show them in the occurrence preview:

- **On the 29th, 30th, or 31st:** months without that date have no occurrence. RFC requires invalid
  generated dates such as February 30 to be ignored. Do not clamp them to month-end.
- **On the last day:** always use the actual last calendar date of the month. This is a different
  user choice from the 28th, 29th, 30th, or 31st.
- **First–fourth weekday:** generate that ordinal when it exists.
- **Last weekday:** generate the final matching weekday, regardless of whether it is the fourth or
  fifth occurrence.
- **Fifth weekday:** omit initially. Microsoft Graph's user-facing recurrence model omits it, and it
  exists only in some months. Add it only with an explicit skip-when-absent explanation if users ask.

RFC's `BYSETPOS=-1` example also shows why “last weekday” is a stable semantic rather than shorthand
for “fourth weekday.”
[RFC 5545 §3.3.10](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10)

### Time zone and daylight-saving behavior

Persist an IANA time-zone identifier with each schedule rather than repeatedly interpreting saved
clock times in the server's zone. RFC identifies local date-times with a `TZID`, and Google Calendar
requires a time zone for recurring events.
[RFC 5545 §3.3.5](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.5),
[Google Calendar recurring events](https://developers.google.com/workspace/calendar/api/guides/recurringevents#creating_recurring_events)

Define and test Moss's behavior instead of inheriting runtime-library accidents:

- Fixed dose times occur **once per local calendar date** and remain at the same displayed local
  time after a daylight-saving change.
- If a selected local time falls in the spring-forward gap, move that day's occurrence to the first
  valid instant after the gap; do not silently lose the occurrence.
- If it falls in the repeated fall-back hour, use the earlier instant and generate only one
  occurrence. RFC explicit local date-times similarly select the first repeated occurrence.
- Every-N-hours schedules preserve real elapsed spacing across a clock change, so their displayed
  local hour may change.

The spring-gap choice is an explicit Moss reliability policy. RFC's recurrence grammar can ignore
generated nonexistent local times, which would silently omit a reminder; that is a poor default for
a medication log. The preview and tests should make Moss's different behavior unambiguous.
[RFC 5545 §3.3.5](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.5),
[RFC 5545 §3.3.10](https://www.rfc-editor.org/rfc/rfc5545.html#section-3.3.10)

If Moss later supports travel behavior, offer an explicit choice between keeping the schedule's
home time zone and moving it to the new local zone. Do not silently rewrite stored schedules when a
profile time zone changes.

## Reminder generation

The recurrence engine should produce canonical occurrence identities; both the Today schedule and
notifications consume those same occurrences. This avoids a second reminder-only interpretation of
the schedule.

1. Expand a bounded future window from the saved recurrence, anchor, time zone, and dose times.
2. Give each occurrence a stable identity derived from medication + scheduled instant (or original
   local occurrence identity where ambiguity handling requires it).
3. Upsert one reminder per occurrence; regenerate the future window after a schedule edit and
   cancel reminders for removed future occurrences.
4. Never change future occurrence times because the user logged one late, skipped one, or failed to
   log it.
5. Do not generate scheduled reminders for PRN medications.

Apple provides a useful product precedent: setting a medication schedule creates log reminders,
while an optional follow-up reminder fires 30 minutes later only when the scheduled medication has
not been logged. Moss can preserve its existing notification controls, but schedule and reminder
generation should share one occurrence source.
[Apple Health medications](https://support.apple.com/guide/iphone/track-your-medications-iph811670c81/ios)

## User-friendly interaction shape

1. **How often?** Show the six common schedule families as a compact list.
2. **Complete the sentence.** Reveal interval, weekday, monthly-position, or cycle controls only for
   the selected family.
3. **When?** For scheduled families, add one or more dose times. “Every N hours” instead asks for the
   interval and first date-time.
4. **Starting / ending.** Require a start date; put optional end date behind “Add end date.”
5. **Preview.** Render one plain-language sentence and the next three occurrence date-times.
6. **Reminder settings.** Reuse the same generated occurrences; do not ask the user to recreate the
   cadence in a second reminder form.

Natural-language examples from Todoist demonstrate that people understand sentence forms such as
“every Monday and Friday at 20:00,” “every 12 hours starting at 9pm,” multiple month dates, and nth
weekdays. Its documented unsupported combinations also show the cost of making text parsing the
only interface. Moss should borrow the readable summary, not the parser.
[Todoist recurring dates](https://www.todoist.com/help/articles/introduction-to-recurring-dates-YUYVJJAV)

## Scope guidance for #1349

Include:

- the six schedule families above;
- every N days, weeks, and months;
- first through fourth and last weekday of a month;
- numbered day of month plus last day;
- multiple local dose times where applicable;
- a required anchor/start and optional end date;
- a normalized sentence and next-three preview;
- reminders derived from the same occurrence expansion;
- explicit tests for short months, leap day, daylight-saving transitions, and schedule edits.

Defer until requested:

- raw RRULE entry/export;
- natural-language recurrence parsing;
- fifth weekday, business-day, holiday, and arbitrary set-position rules;
- completion-relative recurrences;
- per-occurrence rescheduling UI and “this and following” series splits;
- automatic travel-time-zone conversion;
- dose recommendations or interpretation of clinical instructions.

This research concerns faithful schedule transcription and reminder mechanics only. Moss should not
suggest a medication cadence or resolve ambiguous instructions; the user must enter the schedule
they already intend to track.
