# Rust phase 5, News/Sports/Weather part 22 (remainder) report

Task JS-340. Scope from the plan row: registry packaging and signing for all three, upgrade check on a copy of dev data, whole-module live pass against the real services, Briefings re-proof with all three.

## Built

- One combined live test, `rust-spike/module-host/tests/suite_server.rs`, run by `pnpm test:rust-suite-live`.
- It builds Weather, News, Sports and Briefings packages, signs all four into one folder registry, installs them from it into the real Rust server over HTTPS, and exercises each through the real routes.
- Optional switches. `SUITE_DEV_COPY` loads rows copied from the dev database. `SUITE_LAN_HOST` adds a LAN address to the certificate. `SUITE_HOLD_OPEN` keeps the server up for a browser. `BRIEFINGS_REAL_MODEL_*` points the router at a real model.
- NewsAPI (part 6) was dropped by Ben, so nothing keyed to it is covered.

## Checks

- Combined gate `test:rust-suite-live`: pass (rc 0), four packages from one signed registry.
- Upgrade check: rows copied from dev (4 follows, 3 sports sources, 2 news sources, 5 news choices, the saved place) were loaded into a throwaway database before the server started. Through the real routes the server read back 4 follows, 3 sports sources (2 saved plus ESPN), 2 news sources, 5 news choices, 1 topic, and the saved place. Dev and prod were only read. The copy is deleted.
- Weather: real Open-Meteo reading for the saved dev place (San Diego) and an hourly forecast.
- Sports: real ESPN follow, overview with 5 cards, standings, and latest result route.
- News: real BBC feed previewed and saved, 39 ranked stories read.
- Briefings: one run through the real worker. Weather and news text reached the prompt. The sports block was present and said "none today", which is correct because no followed team played that day.

## Defects found

- Sports overview with several followed leagues answered an empty 400 on its first three tries after a cold start, then 200 on the fourth. It repeated in every run with five follows. It did not happen with one follow. The test retries, and the cause is not found.

## Not proven

- Reddit. Every preview over four tries and six runs came back rate limited or not found, so no real subreddit was saved in this suite. The sports package test covers the Reddit path separately.
- Real model on the combined install. The run failed after about 90 seconds and the model proxy logged no request from the server, so the cause is not known. The proxy itself answers. The Briefings part 22 report proved this path with Briefings alone.
- Phone-size browser pass over the LAN address. Not run.
- Keys. Dev holds none and NewsAPI was dropped.
- Saved topic. Dev holds none, so one was added by hand to check topics survive.
- The cold-start sports 400 above.
