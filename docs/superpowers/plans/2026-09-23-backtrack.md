# Backtrack build plan

Spec: `docs/superpowers/specs/2026-09-23-trail-marker-screen-history.md` (approved by Ben,
2026-09-23), mockups in `docs/superpowers/specs/mockups/backtrack.html`. Part of #2638. Revision 3
answers two gpt-6-astra review rounds (both REJECT); see §8 and the ledger in §9.

Only Phases 0 and 1 are planned in detail. Phases 2 to 4 are outlined, with their seams cited and
their constraints fixed, and they are re-planned after the Phase 1 kill gate (§7).

Citations are against `origin/main` after #2635 (`MenuModel.swift:86` returns "Paused"), with paths
under `apps/trail-marker/TrailMarker/` unless given in full.

## 1. Phases

| Phase | Ships                                                                                                                                                                                | Who sees it                         | Leaves the Mac                 |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------ |
| 0     | Fixes to the shipped app (#2643): capture the focused window by identity, make pause stop every send, clear preferences on log out. Then Pause All, the Focus switch, forest accent. | Everyone                            | Unchanged: Focus as today      |
| 1     | Backtrack capture: recognition, dedupe, sanitising, budget, settings tab, consent, menu row and dot.                                                                                 | **Debug builds only** (`#if DEBUG`) | **Nothing**                    |
| 2     | Server: ingest route, `backtrack` module, table, RLS, index job, lifecycle, a hard retention backstop, Moss settings and delete. Behind a server feature flag, off by default.       | Nobody until the flag is on         | Text segments, once flag is on |
| 3     | Chat tool `backtrack.search` with calendar-aware ranges.                                                                                                                             | Flag                                | —                              |
| 4     | Nightly 30-day summary into the notes folder; raw day deleted after. **The flag turns on only when Phase 4 ships**, so no stored data outlives its promised lifetime.                | Everyone who opts in                | —                              |

Changes from spec §13, all to keep a promise true in every shipped state:

- Phase 1 sends nothing and is compiled only into Debug builds. A Release build contains no
  Backtrack code, so no user sees a switch whose consent text describes storage that doesn't exist
  yet (round-1 #10).
- Phases 2 to 4 ship dark behind one server flag, turned on together. Phase 2 also adds a hard purge
  at 37 days (30 days plus the spec's 7-day summary retry), so even a dark-shipped table can't grow
  past the promise (round-1 #10).

The spec is updated to match in the PR that carries this plan: §5 on window identity and redaction
limits, §13 on phasing.

## 2. Seams check

Proven present:

- `WindowCapturing` (`Services/ScreenCapture.swift:14-15`). `selectCaptureWindowIndex` picks the
  **largest** on-screen window for a bundle (`:32-36`). This is a defect in Focus today (#2643), and
  Phase 0 replaces it.
- `FrontmostObserver` (`Services/FrontmostObserver.swift:58`) reads the focused window title through
  `kAXFocusedWindowAttribute` (`:31-51`). It gets activation notifications at `:81` and polls titles
  at `:86`.
- `ObservationPolicy.allows` / `neverWatches` (`Model/ObservationPolicy.swift:62,70`). The policy is
  a value type that changes live through `FocusRuntime.setExcluded` (`App/FocusRuntime.swift:180`).
- `TextRedactor.clean(_:limit:)` (`Model/TextRedactor.swift:6,16`) strips emails and long token
  runs. The server patterns are in `packages/ai/src/adapters/redact.ts:12-28`, and that file says
  pattern matching can't find arbitrary secrets (`:48-50`).
- Wake: `NSWorkspace.didWakeNotification` (`App/FocusRuntime.swift:160`,
  `App/ConnectionRuntime.swift:202`).
- Pause All is `ConnectionEvent.userDisconnect` / `userConnect` (`Model/ConnectionMachine.swift:5-6`).
  Titles come from `MenuModel.statusTitle` (`Views/Menu/MenuModel.swift:83`, "Paused" at `:86`) and
  `primaryActionTitle` (`:93`, "Resume" at `:96`).
- The retired `focusPaused` key is deleted on launch (`Services/PreferencesStore.swift:13,26`).
- `PreferencesStore.clearAll()` exists (`:135`) and **has no caller** (#2643).
- Sends that ignore pause today (#2643): `FocusRuntime.testVision` (`:249`), `correct` (`:306`), the
  capture-to-describe step with no cancellation check (`:466-471`), and `ConnectionRuntime.rename`
  (`:183`).
- The menu-bar image is the template `MenuBarMark` (`App/MenuBarController.swift:28-30`).
- `SettingsSection` (`Views/Settings/SettingsWindow.swift:3`).
- The app map's Trail Marker text (`packages/shared/src/app-map-core.ts:99`) describes what a linked
  Mac may do. Phases 0 and 1 don't change that; Phase 2 does.

Proven absent, so each is net-new: Vision text recognition; AX reads of secure fields and browser
addresses; screen-lock, low-power and thermal handling; an app accent colour
(`Resources/Assets.xcassets` has only `MenuBarMark` and `MossMarkColor`); a UI-test target in
`project.yml`.

Open questions, each with an owner:

- **Q1 (Phase 1 builder):** can AX enumerate every `AXSecureTextField` in a window's subtree, with
  frames, within a 50 ms budget, in Safari, Chrome, Arc and Electron apps? The rule in §4.2 holds
  either way: if the enumeration can't be completed, that capture is skipped. Record what each app
  actually allows.
- **Q2 (Phase 1 builder):** how each browser exposes its address (Safari `AXURL`, Chrome and Arc
  `AXDocument`, Firefox). A browser that exposes none gets no address; the builder never guesses
  one.
- **Q4 (Phase 0 builder), answered 2026-09-23 from a live Chrome measurement.** Accessibility has
  no public call that returns a window's `CGWindowID`, so the plan uses public API only.
  - **The binding is the frame.** A capture takes a window only when exactly one on-screen window
    of the pid has the fresh AX focused window's frame (±1 pt). The AX window is read fresh just
    before capture and again after it, and the post-capture read must equal the first
    (title and frame).
  - **The capture title is not compared at all.** For the same Chrome window and frame,
    ScreenCaptureKit both drops the tail Accessibility adds (for example "- High memory usage - 908
    MB - Google Chrome") and shortens long titles in the middle ("Trivia & Networkin… - Gmail").
    No title rule survives that. Two windows of one app at the same frame are ambiguous, so neither
    is taken; that covers a normal and a private window both maximised.
  - **Private windows are the policy's job,** checked on the full fresh AX title, not the window
    match's.
  - Safari, Arc, Ghostty and Messages are still to be recorded by the Phase 0 live proof.
- **Q3 (Phase 3 planner):** the calendar module's public API for "events overlapping a time range".
  It is not verified; Phase 3 must cite it or add it.

## 3. Phase 0 (shipped app, one PR per bullet group, in this order)

### 3.1 Capture exactly the window the policy checked (#2643 item 1)

```swift
// Services/FrontmostObserver.swift: Observation gains the window's identity
struct Observation: Equatable { let appName: String; let bundleId: String; let windowTitle: String
    let pid: pid_t; let window: WindowIdentity? }          // nil when AX can't name the focused window
struct WindowIdentity: Hashable { let frame: CGRect; let title: String }  // the AX focused window; matched to an SCWindow by pid+frame(+title), see Q4

// Services/ScreenCapture.swift: capture by identity, never by bundle
protocol WindowCapturing {
    func capture(_ window: WindowIdentity, pid: pid_t, maxDimension: CGFloat) async throws -> CGImage
}
enum ScreenCaptureError { …, case identityMismatch }       // zero or several SCWindows match the identity
```

Rules:

- **Capture fails closed; app-name observation does not change.** A new
  `ObservationPolicy.allowsCapture(_:)` is `allows(_:)` **and** `window != nil` **and**
  Accessibility is granted, so a private-window title check actually ran. Focus's app-name-only
  judgment still uses `allows(_:)` unchanged, so people without Accessibility keep today's Focus.
- Capture selects the `SCWindow` matching the identity (see Q4). If there is no match, or more than
  one, it throws `identityMismatch` and nothing is described.
- `selectCaptureWindowIndex` is deleted.
- Focus's JPEG encoding moves into the describer path, so `WindowCapturing` returns a `CGImage` for
  both Focus and Backtrack.

Tests:

- A small ordinary window in front of a larger private window of the same browser: capture returns
  the ordinary window, or throws. It never returns the larger one. Observe this failing against
  today's largest-window selection.
- With AX denied, `allowsCapture` is false for every app, and `allows` is unchanged (Focus
  app-name judgment still runs). This fails if the fail-closed rule is put on `allows`.
- Two same-size windows of one app at the same frame: identity is ambiguous, so it throws, and
  there is no capture.
- Focus moves to another window between the policy check and the capture: `identityMismatch`, and
  nothing reaches the describer.

### 3.2 Pause stops every send (#2643 item 2)

- `testVision` and `correct` are Focus operations. They return early, sending nothing, while
  `connection.state == .disconnected` **or** the Focus switch is off. Settings shows "Paused:
  resume to test". `rename` is a connection operation: it is gated on Pause All and link state
  only, never on the Focus switch, and its task is tracked so Pause All cancels it (round 2 B4).
- Between capture and describe, the runtime re-checks `!Task.isCancelled && shouldObserve` on
  **both** capture paths: the automatic one (`FocusRuntime.swift:466-471`) and Test vision's own
  (`:292-296`). It checks again before the judge request. The machine cancels in-flight work on
  `userDisconnect`, sleep and Focus switch-off.
- **Tests go through a transport spy, not the machine.** A `URLProtocol` stub fails the test on any
  request. Invoke each of `testVision`, `correct` and `rename` while paused: no request. Start a
  capture, fire Pause All while it is suspended, and resume the capture fake: no describe call and
  no judge request. Observe each one failing with its guard removed.

### 3.3 Log out clears everything (#2643 item 3)

- `ConnectionRuntime` calls `preferences.clearAll()`, then deletes the Keychain item, on every path
  that ends a link: user log out (including log out while disconnected, which
  `ConnectionMachine.swift:140-148` must now accept), server revoke, and credential invalid.
- **The running app resets too, not only the stored keys (round 2 B3).** `FocusRuntime` caches
  consent, policy and vision configuration (`FocusRuntime.swift:120-137`). On every end-of-link path
  it reloads them from the cleared preferences, resets its machine (`FocusMachine(policy:)` fresh),
  drops `lastJudgment` and `lastKnownApp`, and cancels tracked tasks. From Phase 1,
  `BacktrackRuntime` does the same via `discardAll`.
- Tests, through the runtime:
  - With focus preferences set, log out while connected and while paused: `defaults` holds none of
    the reset-list keys.
  - Log out, then relink a **different account** without restarting: consent is off, the policy is
    empty, and nothing is observed until the new account opts in.
  - Observe each failing with its reset removed.

### 3.4 Pause All, the Focus switch, forest accent

```swift
// Views/Menu/MenuModel.swift
enum MenuItemDescriptor.Kind { case text, separator, toggle }
enum MenuItemDescriptor.Role { …, case focusSwitch }        // backtrackSwitch arrives in Phase 1
struct MenuItemDescriptor { …; var isOn: Bool = false }
// primaryActionTitle: .connected -> "Pause All", .disconnected -> "Resume All"

// Services/PreferencesStore.swift: new key; in the clearAll reset list
static let focusSwitchedOff = "focusSwitchedOff"            // Bool, default false

// Model/FocusMachine.swift
case userSwitchedFocus(on: Bool)
```

Accent: add `Resources/Assets.xcassets/AccentColor.colorset` with `#173E2B` in light and dark, and
set `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: AccentColor` in `project.yml`. Update design
guide §10.

Tests:

- The primary titles are right.
- With the Focus switch off, the spy transport sees no request from app switches, samples, dwell,
  wake or stale replies. Observe it failing with the switch check removed.
- During Pause All the Focus row keeps `isOn` and has `isEnabled == false`.
- A stored `focusPaused = true` does not switch Focus off. This is tested through app launch
  (`PreferencesStore` init plus `FocusRuntime` init), not the machine alone.
- `focusSwitchedOff` is cleared by log out (§3.3).

### 3.5 Phase 0 end-to-end

Add a `TrailMarkerUITests` XCUITest target. Debug builds accept the launch argument
`-TMHostCardInWindow YES`, which hosts `StatusCardView` in an ordinary window, since XCUITest can't
drive a status item. The test drives a stubbed connection:

- It asserts the Pause All and Resume All titles.
- It toggles Focus and asserts the row's state.
- It asserts that during Pause All the Focus switch is disabled and keeps its position.
- It opens Settings and asserts the sidebar still has its sections.

Live proof, recorded on the PR (round 2 A12). Install the build to `/Applications` on Ben's Mac,
then:

1. Put a small ordinary Safari window in front of a larger private one and run Test vision. The
   picture is the ordinary window.
2. Use Pause All, then run Test vision and Rename. Nothing is sent: the debug log shows no request.
3. Log out and relink. Focus is off and the Never watch list is empty.
4. Check the menu shows Pause All, the Focus switch and the forest accent.

Release notes:

- PR 3.1–3.3: `Fixed` / "Trail Marker privacy fixes" / "Trail Marker now only ever looks at the
  window you're using, stops everything while paused, and forgets its settings when you log out."
- PR 3.4: `Changed` / "Pause All and a Focus switch" / "The Trail Marker menu has Pause All plus a
  switch to pause just Focus."

App map (round 2 B5): this is updated in the same PR, not skipped. `app-map-core.ts:99` (the Trail
Marker group) gains the menu's Pause All and Focus switch, and the rule that captures need
Accessibility and a verifiable focused window, with its remediation ("grant Accessibility in
System Settings"). It also notes that Test vision is unavailable while paused.

## 4. Phase 1 (Debug builds only; nothing leaves the Mac)

### 4.1 Contracts

```swift
// Model/BacktrackMachine.swift: pure; the clock is an input, never read inside
enum BacktrackEvent {
    case started(BacktrackInputs)                               // initial snapshot, required before anything else
    case inputsChanged(BacktrackInputs)                         // any change to consent/switches/pause/lock/sleep/permissions/policy/link
    case frontmostChanged(Observation?, at: Date)               // nil = no frontmost window
    case tick(generation: Int, at: Date)
    case thumbnailChecked(generation: Int, changed: Bool, at: Date)
    case captured(generation: Int, at: Date)                    // pixels in hand, before recognition
    case recognized(generation: Int, lines: [String], address: String?, at: Date)
    case failed(generation: Int, at: Date)
}
struct BacktrackInputs: Equatable {
    var enabled: Bool, consentAccepted: Bool, menuSwitchOn: Bool
    var pausedAll: Bool, screenLocked: Bool, sleeping: Bool, linked: Bool
    var accessibilityGranted: Bool, screenRecordingGranted: Bool
    var budget: BacktrackBudget                                 // .normal / .reduced
    var policy: ObservationPolicy
}
enum BacktrackEffect {
    case schedule(after: TimeInterval, generation: Int)
    case checkThumbnail(Observation, generation: Int)
    case capture(Observation, generation: Int)                 // by WindowIdentity (§3.1)
    case recognize(generation: Int)                             // runtime holds the pixels, never the machine
    case cancelInFlight                                         // drop pixels, cancel tasks
    case emit(BacktrackSegment)
    case discardAll                                             // wipe dedupe state and the debug ring
}
struct BacktrackMachine {
    mutating func handle(_: BacktrackEvent) -> [BacktrackEffect]
    var isRecording: Bool { get }                               // drives the dot and the menu row
}
struct BacktrackSegment: Equatable {
    let appName: String, bundleId: String, windowTitle: String, address: String?   // all sanitised (§4.3)
    let lines: [String]; let start: Date; let end: Date
}
protocol TextRecognizing { func recognize(_ image: CGImage) async throws -> [String] }   // VisionTextRecognizer
protocol SecureFieldLocating { func secureFieldFrames(pid: pid_t, window: WindowIdentity, budget: TimeInterval) -> [CGRect]? }  // nil = couldn't complete
protocol BrowserAddressReading { func address(window: AXUIElement, bundleId: String) -> String? }   // the same AX window the capture was bound to
enum BacktrackSanitizer { static func line(_: String) -> String; static func title(_: String) -> String; static func address(_: String) -> String? }
struct SegmentDeduper { mutating func newLines(for: WindowIdentity, lines: [String]) -> [String] }
// Services/PreferencesStore.swift (all in clearAll's reset list)
static let backtrackEnabled = "backtrackEnabled"; static let backtrackConsentAccepted = "backtrackConsentAccepted"; static let backtrackSwitchedOff = "backtrackSwitchedOff"
```

### 4.2 Machine rules

- **Recording** means all of these hold: `enabled`, `consentAccepted`, `menuSwitchOn`, not
  `pausedAll`, not `screenLocked`, not `sleeping`, `linked`, both permissions granted, a non-nil
  frontmost observation, and `policy.allowsCapture(observation)`.
- **Generation** increases on every `inputsChanged`, on every `frontmostChanged` (including a
  return to the same window, so A to B to A still invalidates A's first capture), and on every
  `cancelInFlight`. Any event carrying an older generation produces no effect.
- **Stop conditions cancel.** An `inputsChanged` that makes recording false emits `cancelInFlight`.
  So do a `frontmostChanged` to a never-watched app or to nil, and a policy change that excludes the
  current app. Log out, revoke, consent revoked, or `enabled` going false also emits `discardAll` (round 2 A2).
- **Revalidation at each boundary.** `captured` and `recognized` produce `recognize` or `emit` only
  if the generation is current **and** recording is still true. Checking only for an old generation
  isn't enough on its own; the recording check is separate.
- **One in flight.** At most one check-capture-recognize chain runs. A new trigger while one is
  running supersedes it: generation increases and `cancelInFlight` is emitted.
- **Budget (one global deadline; round 2 B6).** Let `minGap` be 10 s normally, or 60 s when
  reduced, as spec §5 says. **No recognition starts less than `minGap` after the previous one, from
  any trigger.** A `frontmostChanged` inside the gap is coalesced: only the latest frontmost window
  is recognised, at the deadline, and only if it is still recording and still frontmost. Ticks use
  the same deadline. A budget change applies to the next deadline.
- **Thumbnail decides.** A `tick` emits `checkThumbnail`. Only `thumbnailChecked(changed: true)`
  leads to `capture`. A switch-triggered chain skips the thumbnail.
- **Emit threshold.** Emit a segment only if the deduper returns at least 3 new lines or 80 new
  characters. `start` is the chain's first `at`, and `end` is the `recognized` event's `at`.

### 4.3 Capture and sanitising (runtime)

Order of work, each chain:

1. Locate secure fields with `SecureFieldLocating` (50 ms budget), capture by identity, then locate
   them **again**. If either pass returns `nil`, or the two passes differ (a field moved, appeared
   or vanished), skip this capture (round 2 B2). Otherwise paint every frame, scaled to the image,
   solid black. After capture, confirm the AX focused window still has the same identity (round 2
   B1), and read the address from **that same AX window element** (`BrowserAddressReading` takes
   the window element, not pid and bundle).
2. Recognise.
3. Sanitise every retained field: `line` for each line, plus `title`, `appName` (through `title`),
   and `address`.
4. Dedupe, then emit.

`BacktrackSanitizer`:

- It ports every pattern in `packages/ai/src/adapters/redact.ts:12-28`: bearer, `sk-`, `ghp_`,
  `AKIA`, session tokens, secret query, environment and JSON fields.
- It adds Luhn-valid 13 to 19 digit card numbers and 4 to 8 digit codes near "code", "verification"
  or "OTP".
- Email addresses are kept (Ben, 2026-09-23).
- Before anything else it rejoins lines split by recognition, so a token broken across two lines is
  matched.
- `address` drops userinfo, query and fragment, and replaces any path segment that matches a secret
  pattern, or any path segment of 24 or more token characters, with `…`.
- **Stated limit** (spec §5 and consent copy updated to match): known kinds of secret are removed;
  an arbitrary password typed as plain text in a document cannot be recognised.

### 4.4 UI (Debug builds only)

- `SettingsSection.backtrack` sits between `.focus` and `.permissions`, with symbol
  `clock.arrow.circlepath`. The pane follows mockup B.
- Phase 1 copy, which is truthful for Phase 1:
  - Settings caption: "Debug preview. Reads the window in front of you and keeps the text in memory
    on this Mac only. Nothing is sent to Moss yet."
  - Status: "Recording on this Mac only".
  - "Open in Moss…" is absent.
- The consent sheet uses mockup C's structure with Phase 1 copy: storage is "in memory on this Mac,
  cleared when Trail Marker quits". The sentence about other people's messages stays. Mockup C's
  final copy ships only with Phase 4.
- The menu row `Backtrack` has a switch. The dot appears while `isRecording`: `MenuBarController`
  composites a 6 pt gold dot, keeping the template rendering for the mark.
- Debug focus log line: `Backtrack: <app> · <n> new lines · <address host or "no address">`.

### 4.5 Tests (each says what broken build it catches)

- **Window binding:** covered by §3.1, reused for Backtrack.
- **Every stop condition cancels in flight:** for each input (switch off, Pause All, lock, sleep,
  consent revoked, permission revoked, unlinked, and a policy change excluding the current app)
  fired while a chain is suspended at `captured` and at `recognized`, no `recognize` or `emit`
  follows. Observe it failing for Pause All and for policy exclusion with each check removed.
- **A to B to A:** A's first chain never emits after the return to A.
- **Nil frontmost and startup:** no effect before `started`. `started` with consent absent in the
  preferences records nothing.
- **Secure fields:** with a `SecureFieldLocating` fake returning frames, a spy `TextRecognizing`
  receives an image whose frames are black, checked by pixel at scaled coordinates. With the fake
  returning nil, the recogniser is never called. Unfocused secure fields are included. Observe it
  failing with masking removed.
- **Sanitiser:** covers titles, URL userinfo and path, env/JSON text, a token split across two
  recognised lines, Luhn-valid versus invalid numbers, OTP phrasing, and emails kept. Observe it
  failing with the Luhn check removed, and with line-rejoining removed.
- **Budget:** 20 switches in 10 s, with a recogniser that takes 2 s, start at most 1 recognition
  (normal), and that one is for the last window switched to. Under `.reduced`, recognition starts
  are never closer than 60 s from any mix of switches and ticks. This fails if switches bypass the
  deadline.
- **Dedupe versus threshold:** the deduper turns lines A B C followed by B C D into D. The machine
  emits for a 3-line change and not for a 1-line change of 10 characters.
- **One way out, and only clean data goes through it (Ben, 2026-09-23; replaces round 2 B9's
  "nothing leaves" check).** Backtrack exists to send text to Moss, so the property that lasts is
  not "no network". It is: **every byte of Backtrack data leaves through one boundary,
  `BacktrackSink`, and only a sanitised, policy-allowed segment reaches it, never while stopped.**
  - `protocol BacktrackSink { func accept(_ segment: BacktrackSegment) }` is the only output of
    `BacktrackRuntime` besides `isRecording`. In Phase 1 the sink is the in-memory Debug ring. In
    Phase 2b it becomes `BacktrackUploader`, the one file allowed to talk to `CompanionClient`, and
    the buffer. **The check and the tests below carry over unchanged**; only the sink's
    implementation changes.
  - **Structural check.** Backtrack sources live in `TrailMarker/Backtrack/`. A source check fails
    the build if any file there, other than the named sink implementations, imports `Network` or
    `WebKit`, or references `URLSession`, `NSURLConnection`, `CompanionClient`, `FileManager`,
    `FileHandle`, `UserDefaults` (other than `PreferencesStore`'s keys), `write(to:` or
    `Data(contentsOf:`. Observe it failing with a deliberately added `URLSession` call and with a
    `FileManager` write in a non-sink file.
  - **What crosses the boundary (spy sink, assembled runtime).** Drive the real `BacktrackRuntime`
    with fixture captures and a spy sink, and assert:
    - every accepted segment has passed the sanitiser: fixture secrets appear only masked, in text,
      title and address;
    - no segment is accepted for a never-watched app, a private window, or a window with an
      unlocatable secure field;
    - nothing is accepted while the menu switch is off, Pause All is on, the screen is locked, the
      Mac is asleep, consent is below the version the sink requires, or after log out;
    - a segment that was in flight when a stop fired is not accepted.

    Observe each assertion failing with its guard removed. This is scoped to Backtrack data; Focus
    stays network-capable as today.

  - **Where it goes (Phase 2b addition).** The uploader sends only to the linked instance's origin,
    with the companion credential, and it adds nothing. A transport spy asserts that the request
    body equals the accepted segments. That is observed failing if the uploader adds a field.

- **Release contains no Backtrack:** every file in `TrailMarker/Backtrack/` is wrapped in
  `#if DEBUG` at file level, and a source check enforces that. The Release build succeeds, and
  `strings` on the Release binary finds none of the Backtrack UI strings ("Remember what's on my
  screen", "Backtrack").
- **Recogniser:** a bundled fixture PNG has at least 90% of its words recognised (runs on the macOS
  CI runner).
- **UI (XCUITest, Debug):** the Backtrack Settings tab and consent sheet flow, the menu row appears
  only when enabled, and during Pause All the row is disabled and keeps its position.

### 4.6 Verification (from the repo root; expected exits noted)

```bash
cd apps/trail-marker && xcodegen generate > /tmp/tm-gen.log 2>&1; echo "EXIT=$?"                                  # 0
cd apps/trail-marker && xcodebuild test -scheme TrailMarker -destination 'platform=macOS' > /tmp/tm-test.log 2>&1; echo "EXIT=$?"   # 0 (unit + UI tests)
cd apps/trail-marker && xcodebuild -scheme TrailMarker -configuration Release -destination 'platform=macOS' -derivedDataPath /tmp/tm-rel build > /tmp/tm-rel.log 2>&1; echo "EXIT=$?"   # 0
nm "/tmp/tm-rel/Build/Products/Release/Trail Marker.app/Contents/MacOS/Trail Marker" > /tmp/tm-nm.txt 2>&1; grep -c BacktrackRuntime /tmp/tm-nm.txt; echo "EXIT=$?"   # prints 0, EXIT=1
git diff --quiet origin/main -- packages/shared/src/app-map-core.ts; echo "EXIT=$?"                      # 0 (Phases 0-1 leave the app map unchanged; builder confirms :99 still true)
```

**Live proof on Ben's Mac, recorded on the PR:** the Debug build installed to `/Applications`, then
steps 1 to 4 below; step 5 is the kill-gate measurement.

1. Turn it on and accept consent. Read a web page and a Messages thread. The focus log shows
   segments.
2. With a private window behind a small ordinary one, only the ordinary window's text appears. A
   password form's field, 1Password and an excluded app produce nothing.
3. With a fake `sk-` key and a test card number on screen, the Debug ring shows only masked forms.
4. Pause All, the menu switch and a screen lock each stop recording, and the dot goes off.
5. For CPU over a working day, sample for 8 hours at 60 s intervals:
   `/usr/bin/top -l 480 -s 60 -pid "$(pgrep -x 'Trail Marker')" -stats cpu > /tmp/tm-cpu.log 2>&1; echo "EXIT=$?"`.
   The expected exit is 0 after about 8 hours. Report the mean of the samples, with the target at
   or under 3.0.

Release note: `Category: N/A`, because a Debug-only build ships nothing to users. App map: no
change.

## 5. Determinism boundary

- All UI renders from state or records: menu rows, the dot, settings status, and later Moss's
  settings, storage figures and deletion confirmations. Phases 0 and 1 have no model call.
- Backtrack never injects chat turns. Chat calls `backtrack.search` only when asked.
- The model has exactly two jobs: in Phase 3, answer the question from returned snippets; in
  Phase 4, write one day's note. Each has under 150 words of guidance.
- **Phase 4 acceptance, instead of per-item diff review** (the approved design is automatic, with no
  person in the loop). Each note must pass a boundary validator before any raw data is deleted:
  - schema and length caps;
  - the sanitiser re-run;
  - no copied run longer than 200 characters;
  - every URL and title in the note present in that day's segments (grounded, not invented);
  - the ownership marker present.
    After writing, the note is re-read through `VaultContext` and compared byte for byte. The raw day
    is deleted only after both pass. This exception to `plan-build` §3's diff rule is recorded here on
    purpose.

## 6. Phases 2 to 4 constraints (fixed now, detailed after the gate)

- **Ingest:** a platform route following the focus routes (`apps/api/src/companion-routes.ts:273-361`;
  `requireCompanion` at `:126-139`, owner from the credential at `:280-282`, the module guard
  rejects the companion credential at `:274-278`). It is IP-rate-limited (`:62-80`). The server
  re-runs `redactSecrets` on arrival.
- **Module and migration:** `packages/backtrack/sql/` (the module owns its SQL). The number is
  assigned at build time; the highest now is `0241`. The `screen` source kind needs a separate
  **memory-owned** migration (`packages/memory/sql/0106:8`).
- **Worker access** (round-1 #7): indexing and retention run as `jarvis_worker_runtime`, which is
  `NOINHERIT NOBYPASSRLS` (`infra/postgres/bootstrap/0000_roles.sql:51-57`). Grant it `SELECT`
  (index) and `DELETE` (retention) on the table, following the worker-grant files in
  `packages/ai/sql/0037_ai_worker_read_grants.sql`. The same owner-only policies apply. Integration
  tests run as the real worker role, including cross-owner denial.
- **Retention backstop (round 2 B8):** rows older than 37 days are purged every hour, so the
  strict maximum age is 37 days plus 1 hour. The purge also deletes their `memory_chunks` through
  memory's public API, never memory's table directly. The index job re-reads its segment under the
  actor's context and skips any row that is gone or older than the cutoff, so a queued job can't
  recreate a purged embedding. Search filters out anything past the cutoff too. The purge runs
  whether or not the feature flag is on. Tests cover a purge racing a queued index job, and the
  cutoff boundary. It exists from Phase 2, before summaries do.
- **Payloads:** `ALLOWED_PAYLOAD_KEYS` validates top-level keys only
  (`packages/jobs/src/pg-boss.ts:154-164`). The Phase 2 plan must also cap the length of
  `segmentIds` and validate its values as UUIDs at the send site.
- **Vault:** Phase 4 writes through `withVaultContextAt` (`packages/vault/src/vault-context.ts:63-108`),
  never raw `fs`. The raw writes it must not copy are at `packages/notes/src/daily-archive-writer.ts:81-85`.
- **App map and release notes:** Phase 2 updates `app-map-core.ts:99` ("what the linked Mac may
  do") and adds the module manifest's settings and features entries, in the same PR, describing the
  flag-off state truthfully. Each phase's PR carries its release note. Nothing advertises recall
  before the flag is on.
- **Native rollout (round 2 B7).** Phase 2 includes a native part, "2b", that brings Backtrack to
  Release builds. It adds the batch upload through `CompanionClient`, the encrypted 24-hour offline
  buffer (spec §6), and final consent copy.
  - Consent is **versioned**: `backtrackConsentVersion`, where 1 is the Debug in-memory consent and
    2 is storage in Moss.
  - Upload requires version 2, so a Debug opt-in never authorises sending. Everyone sees the
    version-2 sheet before anything is sent.
  - The sink check from §4.5 is unchanged. `BacktrackUploader` is simply added to its named sink
    implementations, and the spy-sink tests keep running against the uploader.
- **Web e2e:** Phases 2, 3 and 4 each carry a Playwright test on the dev instance:
  - Phase 2: Settings → Backtrack shows storage, and "Delete today" removes today's rows.
  - Phase 3: a question about a seeded segment's page is answered with the Backtrack source chip,
    and an unrelated question makes no `backtrack.search` call.
  - Phase 4: a backdated day becomes a note.

Provisional DDL (a reviewed decision):

```sql
CREATE TABLE app.backtrack_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  app_name text NOT NULL CHECK (octet_length(app_name) <= 400),
  bundle_id text NOT NULL CHECK (octet_length(bundle_id) <= 255),
  window_title text NOT NULL CHECK (octet_length(window_title) <= 1000),
  address text CHECK (octet_length(address) <= 2048),
  body text NOT NULL CHECK (octet_length(body) <= 8192),          -- the spec's 8 KB is bytes
  body_hash bytea NOT NULL CHECK (octet_length(body_hash) = 32),  -- SHA-256 of the UTF-8 body, computed server-side
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', window_title || ' ' || coalesce(address,'') || ' ' || body)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at >= started_at),
  UNIQUE (owner_user_id, device_id, body_hash, started_at)       -- a retried batch is idempotent
);
CREATE INDEX backtrack_segments_owner_time ON app.backtrack_segments (owner_user_id, started_at DESC);
CREATE INDEX backtrack_segments_search ON app.backtrack_segments USING gin (search);
ALTER TABLE app.backtrack_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.backtrack_segments FORCE ROW LEVEL SECURITY;
-- per-verb policies on owner_user_id = app.current_actor_user_id(): SELECT, INSERT, DELETE; no UPDATE
-- GRANT SELECT, INSERT, DELETE TO jarvis_app_runtime; GRANT SELECT, DELETE TO jarvis_worker_runtime
```

Tests the Phase 2 plan must include: a multibyte body at the byte limit, `ended_at < started_at`
rejected, a retried batch not duplicated, cross-owner reads denied for both roles, and account
deletion cascading.

Open for the Phase 2 planner: does `device_id` reference the companion devices table, and does
revoking a Mac cascade to its rows or keep them?

## 7. Kill gate (after Phase 1; Ben decides)

Two working days on the Phase 1 Debug build. The line stops, or returns to design, if any of these
happens:

- the mean CPU from §4.6 step 5 is above 3.0%, or battery drain Ben notices;
- the recognised text for three of his real "what did I see" moments wouldn't answer the question;
- any unmasked secret or never-watched content appears in the Debug ring.

Phase 2 gets its detailed plan only after Ben passes this gate.

## 8. Review

- Round 1 (gpt-6-astra, medium): REJECT, 14 findings.
- Round 2: REJECT. It rated 5 of the round-1 findings resolved and 8 partial; 1 was still open (#6,
  app map). It raised 9 new findings. All of them are folded into this revision 3 without a third
  round (§9).
- Ben accepted two rounds (2026-09-23); no round 3.

## 9. Rulings ledger

Round 1, gpt-6-astra (2026-09-23). The review ran on a branch cut before #2635, which explains parts
of #8.

| #   | Finding                                                                                  | Ruling                                                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Capture takes the largest window, not the one the policy checked                         | **Valid**, and a defect in Focus today → #2643, fixed in §3.1 (window identity, fail closed). Spec §5 corrected.                                                                                             |
| 2   | Lifecycle inputs, cancellation and generation semantics missing                          | **Valid** → §4.1 `BacktrackInputs`, `started`, `cancelInFlight`, `discardAll`; §4.2 generation and revalidation rules; §4.5 tests.                                                                           |
| 3   | Secure-field fallback only covers the focused element                                    | **Valid** → §4.3: every secure field in the window, or skip the capture; tests inspect the recogniser's input.                                                                                               |
| 4   | Redaction ignores title and address; server patterns not fully ported; limits unstated   | **Valid** → §4.3 sanitises every field, ports all of `redact.ts:12-28`, rejoins split lines; spec states the limit.                                                                                          |
| 5   | Pause doesn't stop Test vision, correction, rename or in-flight capture                  | **Valid**, a defect in Focus today → #2643, fixed in §3.2 with transport-spy tests.                                                                                                                          |
| 6   | App map and release notes deferred                                                       | **Valid** → per-phase release notes; app map checked in Phases 0 and 1 (no change, `:99` doesn't cover the menu) and updated in Phase 2.                                                                     |
| 7   | Worker can't read or delete the table                                                    | **Valid** → §6 worker grants and worker-role tests.                                                                                                                                                          |
| 8   | Stale baseline and citations; log out doesn't clear                                      | **Partly stale:** `focusPaused` _is_ deleted on current main (`PreferencesStore.swift:13`), and MenuModel lines differ post-#2635. **Valid:** `clearAll()` has no caller → #2643, §3.3. Citations refreshed. |
| 9   | Budget contradicts immediate switch recognition; no clock; thumbnail outside the machine | **Valid** → §4.1 timestamps in events and a `thumbnailChecked` event; §4.2 one-in-flight, 3 s switch floor; §4.5 rapid-switch test.                                                                          |
| 10  | Consent copy promises unavailable storage; retention deferred past storage               | **Valid** → Phase 1 is Debug-only with truthful copy; Phases 2 to 4 ship dark behind one flag, turned on with Phase 4; 37-day backstop purge from Phase 2.                                                   |
| 11  | "Nothing leaves" test doesn't test it                                                    | **Valid**, and superseded by Ben's point (2026-09-23) that the data does leave, to Moss → §4.5 tests the one exit (`BacktrackSink`) and what crosses it, and carries unchanged into Phase 2b.                |
| 12  | Per-phase e2e and verification incomplete; wrong grep path; CPU command unbounded        | **Valid** → XCUITest target (§3.5, §4.5); commands from the repo root with exits (§4.6); bounded `top -l 480`.                                                                                               |
| 13  | DDL size is characters, not bytes; no time ordering; hash unspecified                    | **Valid** → `octet_length`, `CHECK (ended_at >= started_at)`, SHA-256 with a 32-byte check, idempotent unique key; module SQL directory named.                                                               |
| 14  | Read-back isn't diff acceptance                                                          | **Valid as a rule gap** → §5 records a deliberate exception, because the approved design is automatic, and replaces it with a grounding validator plus a byte-for-byte read-back.                            |

Round 2, gpt-6-astra (2026-09-23), on revision 2:

| #   | Finding                                                                       | Ruling                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Window match may pass without a title; address not bound to the window        | **Valid** → Q4 requires a title match (a failed read is not the same as empty) and a post-capture re-check; the address is read from the same AX window. |
| B2  | Secure-field frames can be stale by capture time                              | **Valid** → §4.3 locates before and after capture and skips on any difference.                                                                           |
| B3  | Clearing defaults doesn't reset the running app                               | **Valid** → §3.3 runtime and machine reset; relink-as-a-different-account test.                                                                          |
| B4  | Rename wrongly gated on Focus; Test vision's post-capture guard missing       | **Valid** → §3.2 rename is a connection operation, tracked; the guard is on both capture paths.                                                          |
| B5  | "No app-map change" violates the same-PR rule                                 | **Valid** (also round-1 #6) → §3.5 updates `app-map-core.ts:99` in Phase 0.                                                                              |
| B6  | Switch trigger bypasses the 10 s / 60 s budget                                | **Valid** → §4.2 one global deadline with coalescing; the test expects 1 start.                                                                          |
| B7  | No phase owns the Release rollout or the consent upgrade                      | **Valid** → §6 native part 2b, versioned consent (v2 required to upload).                                                                                |
| B8  | Backstop leaves embeddings, can race indexing, has no strict bound            | **Valid** → §6 hourly purge (at most 37 days + 1 h), memory API deletion, index re-check, search filter, runs with the flag off.                         |
| B9  | Network/file/Release checks don't prove the property; mixed-window test wrong | **Valid** → §4.5 structural source checks with mutation, sink-only output, file-level `#if DEBUG` and `strings` check; live step 2 corrected.            |

Round-1 items round 2 rated PARTIAL are covered by the rows above: #1 → B1, #2 → A2 `discardAll` on
consent revoke, #3 → B2, #5 → B4, #8 → B3, #9 → B6, #10 → B7 and B8, #11 → B9, #12 → Phase 0 live
proof plus the Phase 3 e2e. Round 2's request for "maintainability checks" named no specific check,
so no action was taken.

Other facts kept from earlier work:

- Focus judgments' 30-day retention isn't enforced (#2637). Backtrack must not copy that gap.
- The companion credential is scoped by construction (`companion-routes.ts:40-43,126-139`); there
  is no allow-list table.
- Emails are kept in Backtrack and stripped in Focus. The two redactors differ on purpose.
