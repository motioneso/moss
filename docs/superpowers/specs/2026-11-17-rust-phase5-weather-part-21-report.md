# Rust phase 5, Weather part 21 (screens) report

## What changed

- Weather package serves two screens: `/settings/weather` (unit, Use my location, place search) and `/forecast` (hourly forecast card).
- Today header shows the real reading from `/api/m/weather/today`, with the existing fallback and a link to Weather settings.
- `module-frame.js` grants geolocation to the weather frame only.
- Manifest screens, settings entry, features and remediation path updated (app map).

## Live proof (real server, real Open-Meteo, desktop 1280x900 and phone 390x844)

- Use my location saved "San Diego, California, United States" from a browser position (device position set through the browser's own location setting, not a faked response).
- Search "Seattle", Use this place, Celsius and Fahrenheit saved and read back.
- Today header showed 7°C, Clear sky, High 11° Low 4° (Celsius) and 45°F, High 51° Low 40° (Fahrenheit).
- Forecast screen showed the evening window, curve, hours, rain and wind facts, source and update time.

## Not proven

- Forecast chat card inside a chat message. Chat messages are plain text in the Rust shell, so the card is a screen.
- Profile pane in the shell. The shell has no Profile screen, so settings are a package screen.
- Evening-mode Today header (the Rust Today has day mode only).
- First load after saving a place once showed "unavailable" on Today and Forecast, and the same calls worked moments later. Cause not isolated.
- One 404 for an unidentified resource in the console of the settings screen.
- Today's other content is sample data.

## Tests

- JS view helper tests, shell Today unit tests, package test for the new files.
