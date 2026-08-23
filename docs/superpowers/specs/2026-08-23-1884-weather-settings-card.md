# Combined Weather settings card (#1884)

**Status:** Approved by Ben on 2026-08-23 from the supplied Settings screenshot and explicit UI
direction.

## Outcome

Account & preferences presents weather location and temperature units as one Weather setting. The
existing location and unit behavior stays intact; only their grouping and unit-control language
change.

## Required UI

- Rename the `Weather location` group to `Weather`.
- Keep the existing place search, candidate selection, current-location summary, and clear action
  inside that group.
- Move temperature units into the same group and remove the separate `Temperature` group.
- Replace the `Use Fahrenheit` switch with one keyboard-operable binary unit toggle. The control
  shows `C` when Celsius is selected and `F` when Fahrenheit is selected; its accessible name must
  identify temperature units, and assistive technology must be able to determine the selected unit.
- Map `C` to the existing `metric` value and `F` to the existing `imperial` value. Preserve current
  query loading, mutation pending, error feedback, persistence, and Today-cache invalidation.
- Reuse the existing JDS switch/control vocabulary and existing tokens/classes. The visible letter
  is state-dependent (`C` or `F`), not a two-option segmented control. Do not add a new style system
  or change the Weather API.

## Verification

- Focused component coverage proves there is one `Weather` group, no `Weather location` or
  `Temperature` group, and the toggle renders `C` or `F` for the saved value.
- Existing weather location and weather unit tests remain green.
- Live authenticated UI proof on the implementation PR shows the combined card in both unit states
  and confirms changing units still updates Today.

## Non-goals

- Changing location search, geocoding, storage, or automatic-location behavior.
- Changing the metric/imperial API contract.
- Adding more unit choices or per-location units.
- Redesigning the rest of Account & preferences.
