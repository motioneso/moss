# Handoff: build the simpler Vocci ring app layout (#3757)

## Task

Build the approved layout in `docs/superpowers/specs/2026-10-25-vocci-ring-app-layout.md`. The mockups are
in `docs/superpowers/mockups/vocci-ring-app-layout/` (`screens.png`). The spec is the scope. Ben approved
it on 2026-10-25.

## Where

- Branch `feat/vocci-app-layout`, in this worktree. It is stacked on `fix/vocci-reminder-banner` (PR 3756),
  so the phone keeps the new reminder. Open the PR against `main`, and say in the body that it includes
  PR 3756's commits until that merges.
- Code: `apps/vocci-delivery/src/ai/moss/vocci/`. The screens are `HardwareActivity.java`,
  `DeliveryActivity.java` and `SetupActivity.java`, styled by `NativeTheme.java`.
- Plain Java. Build with `apps/vocci-delivery/build.sh`. Host tests run with `apps/vocci-delivery/test.sh`.

## Rules

- Behaviour stays the same. Keep every service command, intent action, extra and stored preference name,
  so the app installs as an update.
- Put the state-to-button choice in a plain function with host tests. The app picks the one status-card
  action from the delivery state, account state, permissions and setup state.
- Keep the app map truthful. Update the Vocci entries in `packages/shared/src/app-map-core.ts` and
  `apps/vocci-delivery/README.md` to the new screen names and paths.
- Fill in the PR's Release note: Category Changed, title and one plain sentence.
- Ask Ben nothing about the design unless the spec cannot answer it. Then message the session that
  spawned you, the Vocci-Coordinator pane `wB:pQ` in herdr, with the herdr-pane-message skill.

## Live proof on Ben's phone (required before the PR can be called done)

- Ben's phone adb address is in `~/.config/moss-vocci/README.md`. It sometimes drops, so reconnect with `adb connect`.
  Always pass `adb -s <that address>`. Another device, a Shield TV, may be attached. Never touch it.
- Sign with the kept key. Copy `~/.config/moss-vocci/development.keystore` to
  `apps/vocci-delivery/build/development.keystore` before `build.sh`. Install with
  `adb -s ... install -r`, never uninstall. Uninstalling wipes Ben's ring setup.
- Delivery is running on the phone. Do not stop it, and do not press anything that changes the account
  or the ring. Do not clear audio or exclude recordings.
- Take screenshots with `adb exec-out screencap -p` to a temp folder, outside the repo. Capture home and
  settings. Use `adb shell am start` to reach screens. Check that every action from the old screens is
  still reachable.
- Before posting screenshots on the PR, cover the account name, server address and ring serial. The repo
  and its PRs are public.

## Done means

- `./test.sh` green, with the output in the PR.
- The PR is open with screenshots from the phone, and branch is pushed.
- Report back to the Vocci-Coordinator pane `wB:pQ` with the PR number and a two-line summary. Do not merge.
- Leave the worktree clean, and delete temp screenshots.

## Start

1. Read the spec and look at `screens.png`.
2. Read the three screen files and list every button with the state it shows in.
3. Write the state-to-button function and its tests first, then rebuild the screens.
4. Build, install over the phone's copy, screenshot, and open the PR.
