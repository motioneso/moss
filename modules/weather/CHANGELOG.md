# Weather package

## 0.1.1

- Offer validated Rust chat tools and approval cards where actions ask first.

## 0.1.0

- Weather starts as a built-in package. Today's reading, the hourly forecast, the saved place and unit, place search and the chat tools work as before.
- The place and unit routes moved here from Settings. They keep the same saved values.
- With no saved place, the guess skips private, loopback and tailnet addresses and falls back to the saved time zone.
- Weather settings (unit, Use my location, place search) and the hourly Forecast screen are served by this package and work from a phone.
