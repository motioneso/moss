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

- Behaviour of delivery, setup, upload and the ring stays the same, apart from what the spec changes.
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
- The new app has a new id (`ai.moss.android`), so it installs next to the old `ai.moss.vocci` app. Never
  uninstall, stop or change the old app. Its delivery keeps running. Moving Ben's phone over (spec,
  "Moving Ben's phone to the new app") is done later with Ben, not by you.
- Sign with the kept key: copy `~/.config/moss-vocci/development.keystore` to
  `apps/vocci-delivery/build/development.keystore` before `build.sh`.
- Do not set up a ring in the new app. Two apps must never compete for the ring.
- Prove against the moss-proof test copy, not Ben's production Moss. Its recipe and sign-in are in
  `~/.config/moss-proof/README.md`. Run `./switch-branch origin/feat/moss-android` there so it has your
  web change, and check `./status` first. Use its tailnet address on the phone. Never use port 1533 or
  5173.
- On the phone, prove: Connect to Moss, sign in and approve inside the app, Moss opens full screen,
  Settings > Connections > Hardware opens the native page with "Set up your ring", back returns to the
  same Moss page, an outside link opens the browser, and no ring notification appears.
- On a desktop browser against the same copy, prove Settings has no Hardware entry.
- Take screenshots with `adb exec-out screencap -p` to a temp folder outside the repo. Cover the account
  name, server address and ring serial before posting them on the PR. The repo is public.
- Afterwards, uninstall only the new `ai.moss.android` test install if it is linked to the test copy, so
  the move with Ben starts clean. Say so in your report.

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
