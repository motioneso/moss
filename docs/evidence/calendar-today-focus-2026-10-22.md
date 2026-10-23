# Calendar today focus and Month width proof

Issue #3572; PR #3573. Executed 22 October 2026.

## Candidate and method

Product candidate: `25549578f902f4bad557efc3b104021929c00310`.
Installed image: `ghcr.io/motioneso/moss:uat-calendar-focus-20261022`, ID
`sha256:e0713ce2a11cd1b9145e01510192fb61bf3019b279347fcbc7044b1a36d50979`.
The follow-up commit adds only test/evidence changes; these product bytes are unchanged:

| File                                       | SHA-256                                                            |
| ------------------------------------------ | ------------------------------------------------------------------ |
| `apps/web/src/calendar/calendar-page.tsx`  | `e3dc7f2cb25bd7481528ed0fa4e4a2ee6fa6d58856f739e67dbba669e8ed890a` |
| `apps/web/src/calendar/calendar-month.tsx` | `3afa3609a30054ac90bcb367abe7f18bee76d6a985ca814ba56fb3a55ff50065` |
| `apps/web/src/styles/kit-calendar.css`     | `7263a398921d4feb4d7e13f6178d64161147f6de7f46f4d08ea74ce3c8e50f8d` |
| `packages/calendar/src/manifest.ts`        | `bb77c9a3fb7fddf9e57073dec6d803a1fe52bf36cb85775326128c76d87fe6c8` |

The isolated UAT provisioner used its own database, app, network and volumes. The existing
calendar seed created connector-backed events through the real repositories. The browser
signed in through the real form and exercised the actual Calendar page/API. No network
response was intercepted, rewritten or replayed. No real model login was installed.

The browser clock was fixed at `2026-09-25T00:30:00Z`: September 24 in the saved Los Angeles
zone. Old local date/view preferences reproduce stale navigation without fabricating API data.
Screenshots, trace and video capture were disabled.

## Results

Initial installed run: `uat-2562438_ac900132`, command exit **0**, **3 passed (13.9s)**.

```text
{"width":1280,"weekTodayVisible":true,"monthFits":true,"monthReloadToday":true}
{"width":390,"weekTodayVisible":true,"monthFits":true,"monthReloadToday":true}
{"width":320,"weekTodayVisible":true,"monthFits":true,"monthReloadToday":true}
```

Assertions prove that Week ignores an old saved date, switching after Previous returns Month
to today, today's whole header/cell is inside its scroll region, Month has no horizontal
region/page overflow, all seven weekday columns render, and a seeded January event opens
its full details. Explicit Next still moves to October; reloading Month returns to September.
Today also recovers Week's position after a manual sideways scroll.

Follow-up run `uat-2608446_6d184109`: command exit **0**, **3 passed (12.2s)**, using
the same product image in light (1280px), dark (390px), and Sage (320px) styling.

## Other checks and limits

Four focused regression checks failed before the fix; all **35** targeted calendar tests pass
afterwards. Root/web/external typechecks, scoped ESLint/Prettier, app-map generation,
design-token/UI-class, file-size and ambient-date checks passed. The package build first
caught an app-map description exceeding 240 characters; it was shortened before the
successful image build and proofs.

This verifies the installed isolated candidate, not production deployment or every browser.
Explicit Work week continues to show weekdays only. The provisioner removes its containers,
network and volumes after the run; the agent releases the claimed port and its proof image.
