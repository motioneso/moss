# Build plan — #2027 sign-in adapter for the Gemini command-line tool

**Spec:** the `SPEC` comment on https://github.com/motioneso/moss/issues/2027 (approved).
**Issue:** Part of #2027. **Branch:** `fleet/lane-2027`. **Risk tier:** security.
**Depends on:** #2026 (install recipe) — merged as `0ec333ef5`, present on this branch.

---

## 1. Seams check — every assumption proved against this tree

| Assumption the plan rests on | Evidence on this branch |
| --- | --- |
| The google catalog entry is install-`supported`, so an adapter for it is not an orphan | `packages/cli-runner/src/catalog.ts:151-153` |
| The pinned command name is `gemini` | `packages/cli-runner/src/catalog.ts:168` (`binary: "gemini"`) |
| An adapter's first argv element must equal the catalog binary or the adapter is dropped | `packages/cli-runner/src/login-adapters.ts:207-209` |
| An allowlist entry with pathPrefix `/` is rejected as too broad | `packages/cli-runner/src/login-adapters.ts:213-215` |
| google currently has no adapter | `packages/cli-runner/src/login-adapters.ts:178` (`google: undefined`) |
| Surface extraction takes the first allowlisted https URL and the first token matching the provider's code pattern | `packages/cli-runner/src/login-adapters.ts:76-97` |
| `paste` mode yields `awaiting_token`; `poll` mode yields `awaiting_authorization` | `packages/cli-runner/src/login-service.ts:212-214` |
| Sign-in completion is decided by the provider probe, and the google branch runs `agy --print` today | `packages/chat/src/live/provider-probe.ts:82-87` |
| The runner's child environment is an allowlist filter, not a setter — allowlisting a name alone does nothing | `packages/cli-runner/src/sanitized-env.ts:66-73`, and the comment at `:37-44` |
| `HOME` for the runner's children is forced to the auth volume in one place | `packages/cli-runner/src/main.ts:124-134` |
| First-run seeding exists for claude and codex, and does nothing for google | `packages/cli-runner/src/provider-first-run.ts:120-131` |
| Nothing on the sign-in path calls that seeding — only chat launch and the worker do | grep for `ensureProviderLaunchReady`: `packages/cli-runner/src/engine-host.ts:405`, `apps/worker/src/worker.ts:244`; no hit in `login-service.ts` or `main.ts` |
| The settings screen hardcodes which providers get the sign-in button | `apps/web/src/settings/settings-provider-login-dialog.tsx:16` and `:53-60` |
| The onboarding screen labels this provider "Antigravity" | `apps/web/src/onboarding/cli-auth-step.tsx:39` |
| The presence check already accepts the `gemini` command name (#2026 added the alias) | `packages/ai/src/cli-availability.ts:31-35`, `:86-92` — **no change needed here** |
| The install step writes `.gemini/settings.json` under the same home folder, holding the two self-update keys | `packages/cli-runner/src/catalog.ts` selfUpdateDisable block — **so any seeding we add must merge, never overwrite** |

### Facts read out of the real published tool (version 0.57.0, unpacked outside the repo)

The spec flagged these as read-from-package and asked for confirmation. All confirmed:

- It prints `Please visit the following URL to authorize the application:` then a blank line, the
  link, then a blank line — then `Enter the authorization code: ` and waits on the keyboard.
- The link is built by the standard Google client, whose authorize address is
  `https://accounts.google.com/o/oauth2/v2/auth`. So host `accounts.google.com` with path prefix
  `/o/oauth2` matches, and is narrow enough to pass the too-broad check.
- Its own sign-in step gives up after five minutes.
- It decides it cannot open a browser when `NO_BROWSER` holds any non-empty value, **or** when
  Linux has no display. The runner's child environment does not pass a display through, so the
  paste path is already taken; setting the variable makes it deliberate rather than incidental.
- The sign-in-method question appears only when the setting `security.auth.selectedType` is unset.
  Seeding it to `oauth-personal` skips that question.
- **Deviation from the spec, deliberate:** the spec also asked to seed a colour theme. The tool
  only complains about a theme when one is set and unknown; an unset theme is fine. And the
  sign-in runs before the main screen is drawn at all. Seeding a theme would add a value we would
  have to keep correct across upgrades for no benefit, so this plan does not seed one.
- `--skip-trust` exists, but the folder-trust question also comes after sign-in, so it is not
  needed on the sign-in command. Left out; noted here so a later reader does not re-derive it.

### Open questions

None blocking. The one residual risk is that the live tool prints something we have not predicted;
the live run is the check, and the failure is visible (no link in the dialog), not silent.

---

## 2. Determinism boundary

No model output anywhere on this path. The link and the sign-in state shown to the user come from
the pane text filtered through the allowlist, and from the provider probe — both records, not
generated text. No new prompt, no guidance string, no chat turn injected. Nothing here goes near
the 150-word guidance budget because there is no guidance.

**Security posture, since this is a security-tier lane.** The trust boundary is that pane text is
untrusted input. Two rules keep it that way, and both already exist and are reused unchanged:
only a link matching an explicit host-and-path allowlist is ever shown, and only a token matching
the provider's own code pattern is ever shown as a sign-in code. This adapter adds nothing that
loosens either. It deliberately does **not** set a token-capture pattern: that field exists for
Claude, which prints a credential on success. This tool writes its own credential file, so there is
no credential on screen to capture, and asking for one would only create a way to surface a secret.

---

## 3. Tasks

Each task commits green on its own.

### Task 1 — the sign-in adapter

**File:** `packages/cli-runner/src/login-adapters.ts`

Decisions:

- New allowlist constant `GOOGLE_AUTH_URLS: readonly LoginAuthUrlPattern[]` =
  `[{ host: "accounts.google.com", pathPrefix: "/o/oauth2" }]`.
- New pattern constant `GEMINI_NO_DISPLAYED_CODE_PATTERN: RegExp` — a pattern that matches nothing,
  written so it cannot match, with a comment saying why: this flow shows a link only, never a short
  code, and the shared loose pattern would grab the first ordinary word on screen and present it to
  the user as if it were a sign-in code.
- Replace `google: undefined` with an adapter: `provider: "google"`, `loginArgv: ["gemini"]`,
  `mode: "paste"`, `authUrlAllowlist: GOOGLE_AUTH_URLS`,
  `userCodePattern: GEMINI_NO_DISPLAYED_CODE_PATTERN`,
  `extractSurface: makeExtractSurface(GOOGLE_AUTH_URLS, GEMINI_NO_DISPLAYED_CODE_PATTERN)`,
  and no `tokenCapturePattern`.
- No signature changes anywhere in this file.

### Task 2 — the readiness check

**File:** `packages/chat/src/live/provider-probe.ts`

Decision: `probeGeminiAuth` runs `gemini` with `--prompt` instead of `agy` with `--print`. Same
signature, same return shape, same "reply is exactly OK" rule.

Why it is in scope: sign-in only reports success when this check passes. Left as `agy --print`,
a user would finish the browser round trip and then be told sign-in failed, because the check
cannot run at all — wrong command, and a flag the tool does not have.

### Task 3 — seed the sign-in-method setting, and call it from the sign-in path

**File:** `packages/cli-runner/src/provider-first-run.ts`

New exported function:

```ts
export async function ensureGeminiOnboarded(homeBase: string): Promise<void>
```

Decisions: reads `<homeBase>/.gemini/settings.json`, sets `security.auth.selectedType` to
`"oauth-personal"` only when it is not already set, preserves every other key (the install step
owns the two self-update keys in this same file and must survive), writes the folder `0700` and
the file `0600`, and is a no-op when the value is already right. Same shape as the existing claude
writer.

`ensureProviderLaunchReady` gains a `google` branch calling it.

**File:** `packages/cli-runner/src/login-service.ts`

New optional dependency on `LoginServiceDeps`:

```ts
readonly prepareProvider?: (provider: RpcProviderKind) => Promise<void>;
```

Called at the top of `start`, before the sign-in session is opened, and awaited. Optional so every
existing test keeps working unchanged.

**File:** `packages/cli-runner/src/main.ts`

Wire `prepareProvider` on the sign-in service to seed google under the configured home folder.

Why: without this the adapter is correct and sign-in still hangs, because on a fresh home folder
the tool asks which sign-in method to use before it ever prints the link, and nothing drives that
question.

### Task 4 — make the no-browser choice explicit

**Files:** `packages/cli-runner/src/sanitized-env.ts`, `packages/cli-runner/src/main.ts`

Decisions: add `NO_BROWSER` to the allowed names, and set `NO_BROWSER: "1"` inside
`buildCliRunnerChildEnv` alongside the `HOME` override. Setting it there rather than mutating the
runner's own process environment keeps it in the one already-tested function that builds the child
environment, and matches the existing comment warning that allowlisting alone is a no-op.

### Task 5 — the two hardcoded spots in the interface

**File:** `apps/web/src/settings/settings-provider-login-dialog.tsx`
Add `"google"` to the `AutomatedLoginProviderKind` type (line 16) and to the provider check inside
`supportsAutomatedProviderLogin` (line 59). Without this the settings screen never offers the
button, however well the server side works.

**File:** `apps/web/src/onboarding/cli-auth-step.tsx`
Change the google label from `"Antigravity"` to `"Gemini"` (line 39) — the pinned tool is Google's
Gemini command-line tool, and the old name now names something we do not install.

### Task 6 — tests

**File:** `tests/unit/cli-runner-login.test.ts`

- Rewrite the existing test at line 326 (`rejects beginLogin for a provider with no adapter (agy)`).
  Its claim is now false. `loadLoginAdapters` takes a registry argument, so build a registry with no
  google entry and assert the rejection against that — the behaviour stays covered, the stale claim
  goes.
- New tests mirroring the codex block:
  - the google adapter's command is `["gemini"]` and its mode is `paste`.
    *Fails against a broken build:* a wrong command name is exactly what the loader silently drops,
    leaving sign-in unavailable with nothing logged.
  - a realistic captured screen — the real "Please visit the following URL" wording plus a full
    Google authorize link — yields exactly that link.
    *Fails against a broken build:* a wrong or absent allowlist entry drops the link and the dialog
    shows nothing, which is the exact live symptom we are guarding against.
  - a look-alike link on another host is dropped.
    *Fails against a broken build:* a too-loose allowlist would show a user an attacker-chosen link
    from pane text.
  - ordinary words on the captured screen never come back as a sign-in code.
    *Fails against a broken build:* reusing the shared loose pattern makes the first ordinary word
    on screen appear to the user as their sign-in code.
  - the google adapter has no token-capture pattern.
    *Fails against a broken build:* a capture pattern here would surface a secret from pane text.
- Loader tests both ways: the google adapter survives when its catalog entry is installable, and is
  dropped when it is not.

**File:** `tests/unit/onboarding-provider-login-route.test.ts` (line 193)
Rename the test that uses google as its stand-in for "cannot sign in". It injects its own stub so it
still passes, but its name now claims something untrue.

**New coverage for tasks 3 and 4** (file chosen to match where each unit already lives; a new
`tests/unit/` file if none fits):
- seeding writes the sign-in-method setting and **preserves the install step's self-update keys in
  the same file**. *Fails against a broken build:* a naive whole-file write silently re-enables the
  tool replacing its own pinned bytes — the exact thing #2026 shipped to prevent.
- seeding is a no-op on a second call.
- the sign-in service calls `prepareProvider` before opening the session.
  *Fails against a broken build:* the adapter is right, the setting is never written, and live
  sign-in hangs on an unanswered question — a failure no unit test would otherwise catch.
- the child environment carries `NO_BROWSER`. *Fails against a broken build:* allowlisting the name
  without setting the value is a no-op, which is the trap the file's own comment describes.

---

## 4. Verification

Run per task, and again before opening the pull request. None piped — the exit code must survive.

```bash
pnpm vitest run tests/unit/cli-runner-login.test.ts tests/unit/onboarding-provider-login-route.test.ts > /tmp/2027-unit.log 2>&1; echo "EXIT=$?"   # expect EXIT=0
pnpm format:check > /tmp/2027-fmt.log 2>&1; echo "EXIT=$?"                                                                                        # expect EXIT=0
pnpm lint > /tmp/2027-lint.log 2>&1; echo "EXIT=$?"                                                                                               # expect EXIT=0
pnpm typecheck > /tmp/2027-tsc.log 2>&1; echo "EXIT=$?"                                                                                           # expect EXIT=0
```

Full gate: through the `verify-gate` skill only. Never run `pnpm verify:foundation` unscoped — it
reaches the live development database.

## 5. The end-to-end check for this phase

This is one phase, so it has one end-to-end check, and it is the live one the project rule demands:
on a live development instance, install the Google tool, press sign in, and confirm a Google
authorization link appears in the dialog within a few seconds. Recorded on the pull request as a
comment whose first line is exactly `LIVE-PATH PROOF`.

Completing a real Google sign-in needs a real Google account and a human at a browser. If that
cannot be done in this lane, the honest status is **code-complete, unverified**, said plainly on the
pull request — not "done".

## 6. Kill gate

**The observation that ends this line:** the live run reaches the sign-in step and the dialog shows
no link, and the captured pane shows the tool printing something the allowlist cannot match — for
example a link on a different host, or the tool refusing the paste flow outright.

**What happens then:** stop, do not widen the allowlist to whatever appeared. Record what the pane
actually printed and hand the decision back through the lane record, because widening a
security allowlist to fit an observation is exactly the change that needs a human.

**Owner:** Ben, via the lane record. This lane is security tier, so the pull request needs his
sign-off regardless.

## 7. Rulings ledger

- The sign-in command must be the same program the install step pins, or the loader throws the
  adapter away with nothing logged (`login-adapters.ts:207-209`). This is why #2027 could not be
  built before #2026.
- The presence check needed no change: #2026 already taught it the `gemini` command name via an
  alias list (`cli-availability.ts:31-35`). The spec listed it as a possible change; it is not one.
- Seeding a colour theme, and adding `--skip-trust` to the sign-in command, were both in the spec
  and are both unnecessary: the tool signs in before it draws its main screen, and it only objects
  to a theme that is set and unknown. Recorded so nobody re-derives it.
- The install step and any first-run seeding share one file, `.gemini/settings.json`, under the
  same home folder. Seeding must merge. An overwrite would silently undo the self-update lock.
