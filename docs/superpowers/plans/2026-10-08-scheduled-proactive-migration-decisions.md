# Scheduled/proactive migration decisions

All four decisions below were explicitly approved by Ben during implementation on 2026-10-08.
This approval is separate from ticket publication and mockup acceptance. The reconciled
product spec remains authoritative; these rulings settle the migration recommendations.

## Main chat — #3125

Once designate the owner's most recently active persistent drawer conversation, ordered
by `last_active_at` descending with ID ascending for ties. Preserve other eligible histories
as side chats. Exclude incognito, module conversations and conversations owned by someone
else, including shared foreign conversations. Create Main only when no candidate exists.
Later activity never changes Main. Current eligibility is `owner_user_id = actor`,
`surface = 'drawer'`, `incognito = false`; preserve owner-scoped read/write checks.

## Automatic email choice — #3129

Preserve off conservatively: a saved legacy master-off or email-source-off keeps automatic
email alerts off. Only absence of a saved applicable record defaults alerts on, and only
when access is permitted. Legacy saves persisted whole records, so deliberate off cannot
be distinguished from fallback off persisted while editing an unrelated field; preserve
those off values rather than infer consent. A future explicit email-on choice enables email
alone. Requested tasks and unrelated sources remain independent.

## Canonical quiet hours — #3130–#3131

Profile is canonical storage. Carry forward a sole saved value or identical schedules.
Disagreements, including enabled/off disagreements, require the accepted explicit choice;
retain prior effective consumer policies until that choice saves successfully. Treat nested
quiet hours in a saved whole-record legacy preference as saved because intent cannot be
recovered. With no saved value, preserve Profile's existing default: off, 22:00–07:00,
using the owner's timezone when unset. The Pacific preview schedule remains sample data.

## Unsolicited email budgets and surfaces — #3146–#3147

Preserve saved limits and current unsaved limits: email 3/day, global 8/day, hourly 1.
Count each selected unsolicited email finding once on its selection day in the owner's
timezone across chat/card/notification. Retries and later delivery do not charge again;
dismissal does not refill the email budget. Requested responsibilities spend none of this
budget. Keep non-email behavior intact and share finding identity so selected email does not
produce duplicate proactive surfaces or notifications.

Persist a selected useful email chat result immediately during quiet hours; defer only
outward interruption. This changes existing active-card cap accounting, where dismissal
currently frees capacity; it does not claim that durable once-per-finding accounting exists
already. Implement and verify accounting atomically at the existing scanner boundary.
