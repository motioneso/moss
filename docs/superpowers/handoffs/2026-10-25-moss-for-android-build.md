# Handoff: build Moss for Android (#3761)

## Task

Build the approved spec `docs/superpowers/specs/2026-10-25-moss-for-android.md`. The mockups are in
`docs/superpowers/mockups/moss-android-hardware/` (`screens.png`). The spec is the scope. Ben approved it
on 2026-10-25.

## Where

- Branch `feat/moss-android`, in this worktree. It is stacked on `feat/vocci-app-layout` (PR 3760), whose
  Home and Settings screens the Hardware page merges. Open the PR against `main`, and say in the body that
  it includes PR 3760's commits until that merges. If PR 3760 merges first, rebase onto `origin/main`.
- Android code: `apps/vocci-delivery/src/ai/moss/vocci/`, plain Java, styled by `NativeTheme.java`. Build
  with `apps/vocci-delivery/build.sh`. Host tests run with `apps/vocci-delivery/test.sh`.
- Web code: `apps/web/src/settings/settings-page.tsx`. Use the `design-system` skill before touching it.

## Rules

- Behaviour of delivery, setup, upload and the ring stays the same. Keep every service command, intent
  action, extra and stored preference name, so the app installs as an update.
- No `addJavascriptInterface`, ever. The only link from the site to the app is the intercepted
  `moss-android://hardware` address.
- Keep the app map truthful in the same PR (`packages/shared/src/app-map-core.ts`, the Android entries).
- Fill in the PR's Release note: Category Added, title "Moss for Android", one plain sentence.
- Before pushing web changes, run `pnpm --filter @moss/web typecheck`, eslint on changed files and the
  settings unit tests. Do not run the full gate without the `verify-gate` skill.
- Ask Ben nothing about the design unless the spec cannot answer it. Then message the session that
  spawned you, the Vocci-Coordinator pane `wB:pQ` in herdr, with the herdr-pane-message skill.

## Live proof on Ben's phone (required before the PR can be called done)

- Ben's phone adb address is in `~/.config/moss-vocci/README.md`. It sometimes drops, so reconnect with
  `adb connect`. Always pass `adb -s <that address>`. Another device, a Shield TV, may be attached. Never
  touch it.
- Sign with the kept key. Copy `~/.config/moss-vocci/development.keystore` to
  `apps/vocci-delivery/build/development.keystore` before `build.sh`. Install with `adb -s ... install -r`,
  never uninstall. Uninstalling wipes Ben's ring setup.
- Delivery is running on the phone. Do not stop it, and do not press anything that changes the account or
  the ring. Do not clear audio or exclude recordings.
- The phone's Moss is Ben's production Moss, which does not have your web change. So prove the Hardware
  entry in two parts:
  1. On the phone: the app opens Moss full screen, an outside link opens the browser, and opening
     `moss-android://hardware` from the web view (for example with a test page loaded through
     `adb shell am start`, or a temporary debug intent) opens Hardware, and back returns to the same page.
  2. On a dev copy of Moss with your branch: Settings shows Hardware under Connections when the user agent
     has the `MossAndroid/` marker, and not without it. Claim a port with `devports claim`. Never use port
     1533 or 5173. Use Playwright with a custom user agent for this.
- Take screenshots with `adb exec-out screencap -p` to a temp folder outside the repo. Cover the account
  name, server address and ring serial before posting them on the PR. The repo is public.

## Done means

- `./test.sh` green and the web checks green, with the output in the PR.
- The PR is open with the screenshots, and the branch is pushed.
- Report back to the Vocci-Coordinator pane `wB:pQ` with the PR number and a two-line summary. Do not
  merge.
- Leave the worktree clean, stop any server you started, release its port, and delete temp screenshots.

## Start

1. Read the spec and look at `screens.png`.
2. Read `HardwareActivity.java`, `DeliveryActivity.java`, `NativeTheme.java` and the manifest.
3. Write the problem-notification choice function and its tests first.
4. Build the Moss screen, then the merged Hardware page, then the web Settings entry.
5. Build, install over the phone's copy, prove it, and open the PR.
