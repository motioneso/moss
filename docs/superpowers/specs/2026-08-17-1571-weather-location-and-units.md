# Weather Location and Units

**Status:** Approved

**Date:** 2026-08-17

**Owner:** Ben

**GitHub:** #1571

## Problem Statement

Moss currently represents a user's weather override as latitude and longitude coordinates. Those
values are implementation details, not a reasonable setting for a person to enter. A user who wants
weather for a different location should be able to name a town or city anywhere in the world.

Users also need one global choice between Fahrenheit and Celsius. Today the weather service always
requests Celsius, so users cannot make weather temperatures match the unit they use.

## Solution

Add a Weather settings surface with a free-text location field and a global °F/°C slide toggle. A
user can enter a place such as "San Diego, CA" or "San Diego, CA, USA." Moss resolves the text to a
real place and stores the selected place's canonical label and coordinates behind the scenes. Users
never need to enter or see coordinates.

When a query has multiple plausible matches, show the candidates and require the user to choose one.
Do not autocorrect or silently guess. The selected temperature unit applies to every weather result
independently of the chosen location.

## User Stories

1. As a Moss user, I want to enter a town or city instead of coordinates, so that I can configure
   weather using language I understand.
2. As a Moss user, I want to enter locations from anywhere in the world, so that the override works
   wherever I live or travel.
3. As a Moss user, I want to include a state, region, or country when useful, so that I can identify
   the intended place precisely.
4. As a Moss user, I want a simple place name such as "San Diego, CA" to work, so that I do not have
   to know a provider-specific address format.
5. As a Moss user, I want Moss to show plausible matches for an ambiguous place name, so that I can
   choose the correct location.
6. As a Moss user, I want Moss not to autocorrect or silently guess my intended location, so that it
   never changes my weather to the wrong place without my approval.
7. As a Moss user, I want the selected place's recognizable name shown in settings, so that I can
   confirm what is saved.
8. As a Moss user, I want Today to use my saved place immediately, so that the weather reflects my
   new setting without waiting for an old cache entry to expire.
9. As a Moss user, I want to change the saved place, so that Today follows the new location.
10. As a Moss user, I want to clear my override, so that weather returns to automatic location
    behavior.
11. As a Moss user, I want to select Fahrenheit or Celsius with a slide toggle, so that temperatures
    use the unit familiar to me.
12. As a Moss user, I want the unit preference to be global, so that every Moss weather temperature
    is consistent.
13. As a Moss user, I want changing units to preserve my saved location, so that these independent
    settings do not overwrite one another.
14. As a Moss user, I want changing location to preserve my selected unit, so that I do not have to
    configure both settings again.
15. As a Moss user, I want my unit choice to apply when automatic location is active, so that clearing
    an override does not reset temperature units.
16. As a Moss user, I want an invalid or unavailable location search to leave my current setting
    unchanged, so that a failed lookup cannot break working weather.
17. As a Moss user, I want a useful no-results or provider-error message, so that I know whether to
    refine the place name or try again later.
18. As a Moss user, I want my location and unit preferences to remain private to my account, so that
    another user cannot read or change them.
19. As a Moss user, I want Moss's conversational weather-location action to use place names rather
    than require coordinates, so that the settings screen and assistant share the same mental model.
20. As a maintainer, I want all weather surfaces to consume the same resolved preference, so that
    location and unit behavior cannot drift between Today and future weather views.

## Implementation Decisions

- Add a user-scoped Weather entry to module settings. Its MVP controls are a free-text location
  field, the saved canonical place label, a clear-override action, and an accessible slide-style
  °F/°C toggle.
- Reuse the existing weather-location preference, owner-scoped preferences repository, Weather
  service, Today route, and Open-Meteo forecast client. Do not create a new weather storage system.
- Add a bounded place-search operation using Open-Meteo's geocoding service, matching the existing
  weather provider and avoiding a new dependency, credential, or provider integration.
- Treat geocoding as deterministic place resolution, not an LLM guess. The resolver accepts free
  text and returns a bounded list of canonical candidates with enough human-readable context to
  distinguish them, including locality, region where available, and country.
- A unique, clear match may proceed directly. Multiple plausible matches require explicit user
  selection before saving. No match and provider failure are distinct outcomes, and neither changes
  the saved preference.
- Keep coordinates as internal data required by the forecast provider. The settings UI and
  assistant input accept place text or a selected candidate and never ask the user to type latitude
  or longitude.
- Save only a candidate returned by the resolver, including its canonical display label and
  coordinates. Do not persist unresolved user text as if it were a validated location.
- Preserve the existing automatic IP-based location fallback when no override is saved. Clearing the
  override restores that behavior.
- Store the global unit preference independently from the location override using the existing
  owner-scoped preference infrastructure. No database migration is required.
- Keep the existing internal metric/imperial weather contract and map the UI labels °C/°F to those
  values. The forecast request uses the saved unit rather than the current hard-coded metric value.
- The unit applies to the current temperature, feels-like temperature, and every future weather
  temperature returned by the shared Weather service.
- Update the existing weather-location assistant action to use the same place resolver and
  ambiguity behavior. It must not invent coordinates or select among ambiguous candidates on the
  user's behalf. Existing settings write permission, confirmation policy, undo behavior, and audit
  behavior remain authoritative.
- Make cached weather sensitive to the resolved location and unit, or invalidate the active actor's
  cached weather when either preference changes. The next Today request after a successful save must
  not return weather for the previous preference.
- Keep provider calls bounded and encode user input safely as a query parameter. Provider errors are
  returned as safe application errors without exposing raw response bodies.
- Continue enforcing module isolation: Settings owns user preferences, Weather owns provider lookup
  and forecasts, and collaboration occurs through declared public contracts rather than internal
  imports or cross-module table access.

## Testing Decisions

- The primary acceptance test uses the live authenticated UI, the highest existing seam: open
  Weather settings, enter and save a real place, navigate to Today and observe that place's weather,
  change the place and observe Today update again, toggle °F/°C, and verify all displayed
  temperatures change units while the location remains unchanged.
- Extend that path with an ambiguous query such as "Springfield" and assert that candidates are
  shown and no preference is saved until the user selects one.
- Test external behavior rather than geocoder implementation details. A good test proves what is
  saved and displayed, not which internal function was called.
- Add focused contract/integration coverage for place search, canonical candidate selection, no
  results, provider failure, clearing an override, automatic-location fallback, unit persistence,
  and owner scoping.
- Add Weather service coverage proving both Celsius and Fahrenheit are requested and returned, and
  proving location or unit changes cannot reuse a stale actor-only cache entry.
- Update assistant-tool integration coverage to prove place-name input, explicit ambiguity handling,
  permission/confirmation, audit, and undo behavior without exposing coordinate entry to the user.
- Reuse prior art from the existing weather route integration tests, weather-location assistant-tool
  integration tests, module settings screens, and Today weather rendering tests.
- Live-path evidence on the implementation PR must show one successful location change, a second
  location change, an ambiguous-place selection, and both unit states on a live dev instance.

## Out of Scope

- Per-city temperature-unit preferences.
- Multiple saved or favorite weather locations.
- Autocomplete on every keystroke; explicit search/submit is sufficient for the MVP.
- Silent fuzzy correction or automatic selection of an ambiguous place.
- Asking users to enter or edit coordinates.
- Address-level geocoding, navigation, maps, or location history.
- Replacing the existing automatic IP-based fallback.
- Adding another weather or geocoding provider.
- Device-specific unit preferences.

## Further Notes

- Location and unit are presented together because they are the two user-facing inputs that
  determine a weather result, but they remain independent global preferences.
- Existing saved coordinate overrides remain valid and should render through their saved canonical
  label; users do not need to re-enter them unless they want to change locations.
- If Open-Meteo cannot provide a confidently unique result, explicit selection is the product rule.
  Convenience must not override the user's instruction not to guess.
