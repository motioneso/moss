# Moss for Android: the app opens Moss, with ring settings inside Settings

Status: approved by Ben, 2026-10-25 (mockups below).

Task: #3761. Builds on the ring app layout spec, `2026-10-25-vocci-ring-app-layout.md` (PR 3758, built in PR 3760).

## Problem

- The Android app (`apps/vocci-delivery`, package `ai.moss.vocci`) only manages the Vocci ring.
- To use Moss on the phone, Ben opens a browser separately. Ring settings and Moss settings live in two
  places.

## Goal

- First open connects the app to a Moss instance. It says nothing about the ring.
- The app is how Android opens Moss. It shows the Moss site full screen, with no tab bar.
- Moss's own Settings gains a Hardware entry under Connections, shown only inside the Android app.
- Hardware opens a native page styled like Moss Settings, holding only the ring settings.
- Ring problems also arrive as phone notifications.

## Mockups

`docs/superpowers/mockups/moss-android-hardware/index.html`, rendered as `screens.png`.

1. Moss Settings inside the app, section list open, Hardware under Connections
2. Hardware page, top: status card, recent deliveries, switches
3. Hardware page, scrolled: ring, phone storage, account, troubleshooting, and the problem card

`setup.html`, rendered as `setup.png`:

1. First open: Connect to Moss
2. Sign in and approve on Moss's approval page, inside the app
3. Connected: just Moss

## Decisions

| Question                                     | Decision                                                                                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Native page or web page for Hardware         | Native. A web page would need a site-to-app script bridge, which widens what a web page can do on the phone.                                    |
| How Settings knows it is in the app          | The app's web view adds `MossAndroid/<version>` to its user agent. The web Settings page shows Hardware only when that marker is present.       |
| How the Hardware entry opens the native page | The entry links to `moss-android://hardware`. The web view intercepts exactly that address and opens the Hardware screen. No JavaScript bridge. |
| Which Moss address the app opens             | The origin saved by ring setup. With no saved origin, the app opens the Hardware page, whose status card offers Set up ring.                    |
| Sign-in                                      | Normal Moss sign-in inside the web view, with its own cookies. Separate from the ring's account link.                                           |

## First open: Connect to Moss

- Shown only while the app has no Moss link. Existing installs with a saved link skip it.
- Eyebrow "MOSS", title "Connect to Moss", one field "Moss address", one primary button "Connect".
  No ring, Vocci or delivery wording.
- Connect starts the existing Moss link (`MossLink` / `SetupLink`, phases EMPTY to APPROVAL to LINKED).
- The approval page opens inside the app's web view, not the external browser. The user signs in to
  Moss there once, so the web view is already signed in afterwards.
- While the approval page shows, the app checks the link in the background every few seconds. Remove the
  Check approval button. On approval the app opens the Moss screen.
- A Cancel action in the top bar cancels the attempt and returns to Connect to Moss.
- Errors (bad address, unreachable server, declined) show as one line under the field.
- Web change: the approval page's Android wording says "Moss for Android" instead of "Moss ring
  companion".

## The Moss screen (new launcher)

- New activity, the app's launcher. A full-screen `WebView` on the saved origin. With no Moss link it
  shows Connect to Moss instead.
- Same-origin pages stay in the web view. Any other address opens in the default browser.
- Android back goes back in web history. At the first page it leaves the app.
- Opening Hardware and returning keeps the web view's page and scroll.
- File inputs open the Android file picker, so chat attachments work.
- Web view settings:
  - JavaScript and DOM storage on.
  - File and content access off. Mixed content never. Third-party cookies off.
  - `addJavascriptInterface` never used.
- A load failure shows a plain native retry message, with a Hardware link so ring settings stay
  reachable while Moss is down.

## Web Settings change

- `apps/web/src/settings/settings-page.tsx`: add Hardware as the last item in the Connections group.
- Show it only when the user agent contains the `MossAndroid/` marker. Never in a browser.
- Selecting it navigates to `moss-android://hardware`. It opens no settings pane of its own.
- Spoofing the marker in a browser only shows a link that does nothing.

## Hardware page

One scrolling native page. It merges PR 3760's Home and Settings screens, in this order:

1. Back link "Settings", returning to the Moss screen.
2. Title "Hardware".
3. Status card, with the state-to-button table from the layout spec unchanged.
4. Recent: latest deliveries, tap a row for the recording detail.
5. Ring: Remind me after an hour, Voice messages, Recordings on ring, Set up ring again, About this ring,
   How to use your ring.
6. Phone storage: Clear delivered audio, with the size on the phone.
7. Account: name and origin, Disconnect.
8. Troubleshooting: Permissions and battery.

- Moss Settings look: paper background, cards with a line border, small uppercase group labels, rows
  with a chevron. Use the existing NativeTheme colours and fonts, light and dark.
- Recordings on ring, recording detail, setup and troubleshooting keep their screens. Their back
  returns to Hardware.
- Exactly one primary button on the page, the status card's when the state needs one.

## Ring setup

- Starts from the status card's "Set up ring" on Hardware, or Ring, Set up ring again.
- Picks up at the Vocci account step, reusing the existing Moss link. The Moss section leaves the ring
  setup screen.
- Setting up or redoing the ring never disconnects Moss. Only Account, Disconnect does that.
- Outside Hardware, the app never mentions the ring: no prompt, banner or notification after
  connecting.
- With a Moss link and no ring, the status card shows "Set up your ring" with Set up ring as its button,
  and no ring problem notification is posted.

## Ring problem notifications

- New channel "Ring problems", default importance.
- Post one notification when delivery is enabled and the status card shows a state that blocks
  delivery: can't reach the ring, permission needed, account not connected, setup could not be opened.
- The text matches the card's state line. Tapping opens Hardware.
- Clear it when the state resolves or delivery is stopped. Do not repost the same state while it lasts.
- Keep the existing delivery and long-recording channels as they are.

## Rules

- Existing commands, intents, extras and stored settings keep their names and behaviour, so the app
  installs as an update.
- The state-to-notification choice is a plain function with host tests, next to the state-to-button
  function.
- Keep the app map truthful in the same PR:
  - `packages/shared/src/app-map-core.ts`: the Hardware entry says it is reached from Settings,
    Connections, Hardware in the Android app, and that the app opens the Moss site full screen.
  - Update the Android remediation's path text to match.
  - `apps/vocci-delivery/README.md`.
- Release note: Category Added, title "Moss for Android", one plain sentence.

## Out of scope

- Microphone and location inside the web view. Moss's voice input and browser location stay
  browser-only for now.
- Moss's own push notifications.
- Any change to delivery, upload, setup flow, ring protocol or the reminder.
- Play Store packaging.

## Verification

- `./test.sh` green, including the new notification-choice tests.
- Web unit test: Hardware shows with the marker and is absent without it.
- Host tests: first open shows Connect to Moss only with no Moss link; ring setup starts at the Vocci
  step when a link exists.
- Live on Ben's phone, installed as an update with the kept development key:
  - The app opens Moss full screen, signed in. The existing link and ring setup survive the update.
  - Settings, Connections, Hardware opens the native page. Back returns to the same Moss page.
  - The same Settings in a desktop browser has no Hardware entry.
  - An outside link opens in the browser.
  - Screenshots of the Moss screen, the Settings list and the Hardware page, with account, address and
    ring serial covered before posting.
