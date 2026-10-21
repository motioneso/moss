# First reminder: paired UI proof for PR 3544

The control uses origin/main `e55248548f18380e6a5d987e92b797229664b1df`. The final branch uses `0d03e2792a72e9f47b8dd3b54e9a1a034c4d038b`.

Both runs use the same sequence on separate bare throwaway databases and production-shaped API, worker and web instances:

1. Create the first owner through the real signup form. Skip setup and confirm zero conversations and Main HTTP 404.
2. Without reloading the signed-in page, configure real Codex subscription authentication with the repository's sanctioned UAT helper. Call the genuine provider-install, provider-login and user model-pin endpoints to select a discovered active economy chat model. This is explicit setup, not UI automation of the provider settings. No chat or reminder is submitted by API.
3. Open Chat with Moss, type `remind me in 2 minutes to stretch`, verify Main still returns 404 and the account still has zero conversations, then press Enter in the real composer.
4. On main, assert the rendered failure reply, no reminder schedule, and no Main.
5. On the branch, assert a newly created Main and active reminder. Wait for the real worker, then assert the delivered reminder is visible in that same open drawer, exactly one stored delivery and one run point to Main, and `performance.timeOrigin` is unchanged. No reload is allowed.

No routes, responses, provider messages or clock values are intercepted, mocked, replayed or rewritten. The provider authentication helper copies the operator's existing signed-in credentials into the scratch instance; credentials are not included here. The reminder itself is handled before model launch.

Images are cropped from the captured drawer to show the relevant composer or reply. Original full drawer captures stayed local. Result JSON and action logs contain only throwaway account/resource identifiers and bounded assertions.

## Reproduce

Run from `~/Jarv1s` with Python Playwright and Chrome already installed. Set `MOSS_REPO` to that checkout and `PROOF_DIR` to a private scratch directory, then copy `paired_ui.py`, `auth.mts` and `provision.mts` there. Claim both web ports with `devports` and pass them to the provisioner using `B3543_WEB_PORT`.

`provision.mts` uses the repository UAT provisioner to create and migrate isolated scratch data. It writes the chosen `B3543_STACK_FILE`, remains alive until `B3543_STOP_FILE` is touched, and cleans its containers, volumes, credentials and environment file.

The proof reads `stack-main.json` for `--variant main` and `stack.json` for `--variant branch`, both inside `PROOF_DIR`. Run `python3 paired_ui.py --variant main --run 7` and `python3 paired_ui.py --variant branch --run 8`. Each clean run writes its own `final_runs/run_<n>` artifacts. Image tags in the helper environment select the corresponding built source.

For each image, source was exported with `git archive` at the SHA above and copied into the common workspace dependency image; API, worker and web were all rebuilt. The control and branch therefore use their respective source with the same installed dependencies and build commands. Main's source has no first-reminder fix. Builds set `NODE_ENV=development` only for build commands; the launched instances run in production mode.

## Test proof

The new drawer/stream regression failed before the stream-binding callback was added: `Reminder: stretch` was absent after the background event. After the change, all four targeted drawer/recovery/privacy/stream suites passed: 31 tests. This unit harness mocks network boundaries; the paired UI proof above uses the real scratch services.
