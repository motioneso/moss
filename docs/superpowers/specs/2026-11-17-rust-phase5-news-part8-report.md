# News screen and Today widget (part 8) report

Part of the Phase 5 plan in `2026-11-13-rust-phase5-news-sports-weather-plan.md`. The mockups were approved on 2026-11-17 as an exact copy of the current TypeScript screen.

### What was built

- The News page as a package screen at `/news`. It has the masthead, a five-story carousel that
  pauses on hover and focus, the mosaic, the "from your sources" rail, the in-brief list, topic
  filter chips (shown only when the catalog returns topics), and the story menu with the reason
  form. Loading, empty, filtered-empty, partly failed and broken states all exist.
- The Today widget as its own package screen at `/news/today-widget`. The Today shell has no
  widget host yet, so the widget is declared and shipped but is opened directly.
- The drawn contour art that stands in for a missing story photo is ported to plain JavaScript so
  it matches the TypeScript screen.
- Two small shell changes the sandboxed frame needs. Pictures and site icons are fetched by the
  signed-in parent page and handed over as data addresses, and the frame policy now allows
  `data:` images. External story links open in a new tab through a new `open` message that
  accepts only http and https addresses.
- The manifest declares both screens, a News menu entry, and the `news.screen` and
  `news.today-widget` features so the app map stays true. The Settings screen is part 9.
- Unit tests cover the layout rules, the picture address check and the markup builders (14 tests).
  The real-server test now also checks that both screens resolve and carry the frame policy.

### Live proof

Run on the real Rust server over HTTPS (port from devports, disposable gate database, real feeds
from the internet, nothing intercepted), in a real Chromium at 1280 by 900 and 390 by 844.

- The page showed 25 real stories compiled by the server's own refresh. The lead picture and
  mosaic pictures arrived progressively (about one second each from the real publishers).
- The story menu opened on a real story, with "More like this" and "Less like this".
- The Today widget showed the lead story, three headlines with site icons and the context note.
- Loading was captured on its own frame, and the broken state ("News is unavailable right
  now. Try again") appeared after the frame lost its connection and waited out the 30 second limit.

### Not proven

- A phone on the home network. The phone view is a 390 pixel wide desktop browser, and the
  fixture server listens on loopback only.
- Topic filter chips. The real catalog returned no topics, so no chips were drawn.
- The full-page broken state from a failing server. It was reached by cutting the frame's
  connection, not by a server error. Unit tests cover the rendering of a server error.
- Saving "less like this" with a reason from the screen, and the empty page for a brand new
  account. The routes were proven in the earlier server test, not clicked through the screen.
- Two story pictures returned a real 502 from their publishers in one run. What the screen shows for those
  two stories was not looked at.
- The widget on the Today page itself, because the Today shell has no widget host.
- A note in the widget keeps a gold left rule. It is the design system's pull note and is in the
  approved TypeScript screen, so it was copied. It may conflict with the no-left-border rule.
