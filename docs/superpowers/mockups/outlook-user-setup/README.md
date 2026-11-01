# Outlook user setup — design review

**Draft; no product behavior is implemented here.** All addresses and event counts are fictional.
The fixture uses real `@moss/ui` components and the current Moss tokens. Its only state is in
memory. It has no Microsoft connection, backend, storage, or sign-in form.

From `~/Jarv1s`, with workspace dependencies installed:

```sh
node docs/superpowers/mockups/outlook-user-setup/build.mjs
```

Open the printed HTML path in a browser. The generated file includes its scripts, styles and
self-hosted fonts, so it works offline without a dev server. Pass an output filename as the
first argument to save it elsewhere. Generated HTML is a review artifact, not a tracked build.

Use **Preview state** to visit all fourteen screens. Microsoft sign-in and background completion
are deliberately simulated with that selector. The sign-in button cannot accept credentials or
open a real account. Theme choices cover light, dark, and Sage; controls wrap on narrow screens.
Switch between Alex and Sam to compare independent simulated setups. This demonstrates the
proposed experience, **not evidence of backend isolation**.

Flow to review:

1. Connect Outlook → preparing browser → Microsoft sign-in.
2. Confirm the detected address → first sync → up to date.
3. Expired sign-in → reconnect to the original account.
4. Different account detected → paused until the original account returns or disconnect.
5. Disconnect → removing session → not connected, with a separate removal-failed state.

The draft design is in
[the setup proposal](../../specs/2026-10-22-outlook-user-setup-design.md).

## Fixture validation — 2026-10-22

Fresh headless Firefox checked all 14 states in light, dark and Sage at 1280px and in a 390px
iframe viewport: 84 combinations, with no horizontal overflow. Executable assertions checked
connect, confirm, keep-connected and disconnect actions, separate Alex/Sam in-memory state,
and reset on reload. No page errors or HTTP/HTTPS requests occurred. Cropped desktop and phone
captures were inspected for the review layout; these are not live product acceptance evidence.
The artifact builds successfully and its source passes Prettier. No backend, Microsoft sign-in,
runtime isolation, RLS, collector or production path was exercised by these fixture checks.
