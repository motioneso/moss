# Backtrack build plan

Spec: `docs/superpowers/specs/2026-09-23-trail-marker-screen-history.md` (approved by Ben,
2026-09-23), with its mockups in `docs/superpowers/specs/mockups/backtrack.html`. Part of #2638.

Only Phase 1 is planned in detail. Phases 2 to 4 are outlined, with their seams cited, and are
re-planned after the Phase 1 kill gate (§6).

All `file:line` citations are against `origin/main` at `62ccbb3d2` or later (after #2634 and
#2635).

## 1. Phases

| Phase | Ships                                                                                                           | Leaves the Mac? |
| ----- | --------------------------------------------------------------------------------------------------------------- | --------------- |
| 0     | Menu: **Pause All** / **Resume All**, a Focus switch row, forest accent colour. Independent of Backtrack.       | n/a             |
| 1     | Backtrack capture on the Mac: settings tab, consent, menu row and dot, recognition, dedupe, redaction, budget.  | **Nothing**     |
| 2     | Server: companion ingest route, `backtrack` module, table, RLS, index job, lifecycle, Moss settings and delete. | Text segments   |
| 3     | Chat tool `backtrack.search` with calendar-aware time ranges.                                                   | —               |
| 4     | Nightly 30-day summary into the notes folder, then the raw day is deleted.                                      | —               |

**Change from spec §13:** Phase 1 sends **nothing**. There is no stub route. Segments go to an
in-memory ring shown only in the Debug focus log. This proves the CPU budget, recognition quality
and redaction before any byte of screen text leaves the Mac, and it keeps Phase 1 free of server
work. The spec's §13 is updated to match in the same PR as this plan.

## 2. Seams check

Proven present (cite):

- Frontmost-window capture sits behind `WindowCapturing` (`Services/ScreenCapture.swift:14-15`).
  The concrete `ScreenCaptureKitCapture` (`:39-85`) picks the largest on-screen window for a bundle
  and returns JPEG `Data` at a maximum of 1024 px.
- App switches and title polling come from `FrontmostObserver` (`Services/FrontmostObserver.swift:58`,
  activation notification `:81`, poll timer `:86`).
- The never-watch decision is `ObservationPolicy.neverWatches` / `allows`
  (`Model/ObservationPolicy.swift:62,70`). It combines the fixed denylist, `excludedBundleIds` and
  private-window markers.
- A redaction entry point exists: `TextRedactor.clean(_:limit:)` (`Model/TextRedactor.swift:6,16`).
  It strips emails and long token runs.
- Wake handling exists: `NSWorkspace.didWakeNotification` (`App/FocusRuntime.swift:160`,
  `App/ConnectionRuntime.swift:202`).
- Pause All is the connection machine's `userDisconnect` / `userConnect`
  (`Model/ConnectionMachine.swift:5-6,55`), titled in `MenuModel.primaryActionTitle`
  (`Views/Menu/MenuModel.swift:93`).
- The menu-bar image is a template `MenuBarMark` set at `App/MenuBarController.swift:28-30`.
- The retired key `focusPaused` is removed on launch (`Services/PreferencesStore.swift:26`).
- Settings sections are enumerated in `SettingsSection` (`Views/Settings/SettingsWindow.swift:3`).
- Server seams for Phases 2 to 4 were verified in the same research pass; they are listed in §7.

Proven absent, so each is net-new work in the phase named:

- There is no Apple Vision text recognition anywhere in the app (no `VNRecognizeTextRequest`).
  Phase 1.
- There is no Accessibility read of a browser address or of secure text fields. Only the focused
  window title is read (`FrontmostObserver.swift:31-51`). Phase 1.
- There is no screen-lock, low-power or thermal handling. Phase 1.
- There is no app accent colour asset (`Resources/Assets.xcassets` holds only `MenuBarMark` and
  `MossMarkColor`), and `project.yml` sets no `ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME`.
  Phase 0.
- Capture returns JPEG only. Recognition wants a `CGImage` without a lossy round-trip, so Phase 1
  adds an image-returning method.

Open questions, each with an owner:

- **Q1 (build agent, Phase 1):** can AX give reliable frames for secure text fields in Chrome and
  Arc, so they can be blanked before recognition? If not, the fallback is to skip recognition for
  any window whose focused element is `AXSecureTextField`. The spec's promise holds either way.
  Record which approach shipped.
- **Q2 (build agent, Phase 1):** how does each browser expose its address through AX (Safari
  `AXURL` on the web area, Chrome/Arc `AXDocument`, Firefox)? Record per-browser results. A browser
  that exposes none gets no address, never a guessed one.
- **Q3 (Phase 3 planner):** the calendar module's public API for "events overlapping a time range".
  This is not verified. The Phase 3 plan must cite it or add it to calendar's public API.

## 3. Phase 0: Pause All and the Focus switch (own PR)

Behaviour:

- The primary button's title becomes `Pause All` for `.connected` and `Resume All` for
  `.disconnected`. The status title stays `Paused`.
- A switch row `Focus` appears under the primary button when Focus consent is on. Switching it off
  stops Focus observation and sends nothing. Pause All leaves the switch's position alone and greys
  it out (`isEnabled = false`).
- The app accent colour is forest (`#173E2B`). That makes the primary button, switches and the
  sidebar selection forest.

Contracts:

```swift
// MenuModel.swift
enum MenuItemDescriptor.Kind { case text, separator, toggle }   // add .toggle
enum MenuItemDescriptor.Role { …, case focusSwitch, case backtrackSwitch }  // backtrackSwitch unused until Phase 1
struct MenuItemDescriptor { …; var isOn: Bool = false }

// PreferencesStore.swift: new key, deliberately not the retired `focusPaused`
static let focusSwitchedOff = "focusSwitchedOff"   // Bool, default false; in the log-out reset list

// FocusMachine.swift
case userSwitchedFocus(on: Bool)   // new event; the effect persists focusSwitchedOff
```

Files: `Views/Menu/MenuModel.swift`, `Views/Menu/StatusCardView.swift` (the toggle row, drawn with a
`Toggle` in `.switch` style at `.mini` control size), `Views/Menu/StatusActions.swift`,
`App/FocusRuntime.swift`, `Model/FocusMachine.swift`, `Services/PreferencesStore.swift`,
`Resources/Assets.xcassets/AccentColor.colorset/Contents.json`, and `project.yml`
(`ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: AccentColor`). Also the design guide §10 and the
tests.

Tests (each would fail on the broken implementation named):

- The primary title is `Pause All` / `Resume All`. Fails if `primaryActionTitle` is left as it is.
- With the Focus switch off, no app switch, sample, dwell, wake or stale reply sends anything.
  Mirror the privacy tests #2635 converted. **Observe it failing** with the switch check removed
  from `FocusMachine`.
- During Pause All the Focus row is present, keeps `isOn`, and has `isEnabled == false`. Fails if
  Pause All clears the switch.
- A stored `focusPaused = true` (the retired key) does not switch Focus off. Fails if the new key
  reuses the old name.
- Log out resets `focusSwitchedOff`.

## 4. Phase 1: capture on the Mac, nothing sent

### 4.1 Contracts

```swift
// Model/BacktrackMachine.swift: pure, like FocusMachine; all timing via events
enum BacktrackEvent {
    case enabledChanged(Bool)                 // Settings switch; requires consent
    case switchedInMenu(on: Bool)
    case connectionPausedAll(Bool)            // Pause All
    case screenLocked(Bool), systemSleeping(Bool)
    case powerPressure(BacktrackBudget)       // .normal (10 s) / .reduced (60 s)
    case frontmostChanged(Observation)
    case tick(generation: Int)
    case recognized(generation: Int, window: WindowKey, lines: [String], address: String?)
}
enum BacktrackEffect { case schedule(after: TimeInterval, generation: Int), captureAndRecognize(WindowKey, generation: Int), emit(BacktrackSegment) }
struct BacktrackMachine { init(policy: ObservationPolicy); mutating func handle(_: BacktrackEvent) -> [BacktrackEffect]; var isRecording: Bool { get } }

struct WindowKey: Hashable { let bundleId: String; let title: String }
struct BacktrackSegment: Equatable {
    let appName: String, bundleId: String, windowTitle: String
    let address: String?          // query string and fragment already dropped
    let lines: [String]           // new lines only, already redacted
    let start: Date, end: Date
}

// Services/TextRecognizer.swift
protocol TextRecognizing { func recognize(_ image: CGImage) async throws -> [String] }
struct VisionTextRecognizer: TextRecognizing   // VNRecognizeTextRequest, .accurate, languageCorrection on, on-device only

// Services/ScreenCapture.swift: add to WindowCapturing
func captureFrontmostWindowImage(bundleId: String, maxDimension: CGFloat) async throws -> CGImage

// Model/ChangeDetector.swift: 32×32 greyscale thumbnail, mean absolute difference
struct ChangeDetector { mutating func hasChanged(_ thumb: CGImage) -> Bool }

// Model/SegmentDeduper.swift: per WindowKey, keeps the last capture's line set
struct SegmentDeduper { mutating func newLines(for: WindowKey, lines: [String]) -> [String] }

// Model/BacktrackRedactor.swift: extends TextRedactor's rules, KEEPS emails
enum BacktrackRedactor { static func redact(_ line: String) -> String }

// Services/BrowserAddressReader.swift
protocol BrowserAddressReading { func address(for pid: pid_t, bundleId: String) -> String? }

// Services/PreferencesStore.swift
static let backtrackEnabled = "backtrackEnabled"            // Settings switch
static let backtrackConsentAccepted = "backtrackConsentAccepted"
static let backtrackSwitchedOff = "backtrackSwitchedOff"    // menu switch
```

`BacktrackRuntime` (`App/BacktrackRuntime.swift`) owns the capture, the recogniser and the
notifications, like `FocusRuntime`. In Phase 1 it sends each emitted segment only to
`BacktrackDebugRing`, which holds the last 200 in memory and exists only in `#if DEBUG`. The Debug
focus log shows `Backtrack: <app> · <n> new lines · <address host>`. A Release build discards
segments. Nothing is written to disk and there is no network path.

### 4.2 Rules the machine enforces

- It never captures when any of these is true: Backtrack is disabled or consent is not accepted,
  the menu switch is off, Pause All is on, the screen is locked, the system is sleeping, or
  `policy.neverWatches(observation)` is true. There is no "then check" path: capture effects are
  produced only from `.tick` and `.frontmostChanged` while recording.
- Its cadence is at most one recognition per `budget.interval` (10 s normal, 60 s reduced).
  `.frontmostChanged` recognises immediately. A tick whose `ChangeDetector` reports no change emits
  nothing.
- A `.recognized` event carrying an old generation is dropped. So is one whose window is no longer
  frontmost or is now never-watched.
- Order of work for each capture: blank secure fields (Q1), recognise, `BacktrackRedactor.redact`
  each line, dedupe, then emit only when at least 3 new lines or 80 new characters appear. The
  address has its query and fragment removed before it is stored in the segment.

Screen lock uses the distributed notifications `com.apple.screenIsLocked` and
`com.apple.screenIsUnlocked`. Sleep uses `NSWorkspace.willSleepNotification` and
`didWakeNotification`. Power pressure uses `ProcessInfo.thermalStateDidChangeNotification`
(`.serious` or worse means reduced) and `NSProcessInfoPowerStateDidChange` (low power means
reduced).

### 4.3 UI (mockups A, B, C)

- `SettingsSection.backtrack`, placed between `.focus` and `.permissions`, with symbol
  `clock.arrow.circlepath`. `BacktrackPane` is a grouped `Form` with the sections Backtrack, Status,
  Never watch ("Edit in Focus…" selects `.focus`) and Stored in your Moss. "Open in Moss…" stays
  disabled with a "Coming soon" caption until Phase 2; it never links to a page that doesn't exist.
- The consent sheet opens the first time the switch is turned on. "Not now" leaves
  `backtrackEnabled` false. The copy is exactly mockup C, including the sentence about other
  people's messages.
- The menu shows a `Backtrack` switch row under `Focus` when `backtrackEnabled` is true.
  `MenuBarController` composites a 6 pt gold dot on the template mark while
  `backtrackRuntime.isRecording` is true, keeping the template rendering for the rest of the mark.
- Status line: in Phase 1 it says "Recording on this Mac only (not sent yet)", because there is no
  sending. Truthful copy, not mockup copy, until Phase 2.

### 4.4 Tests (behaviour, and why a broken build fails)

- **Never-watch wins:** a never-watched app, a private window and a password-manager app emit no
  capture effect in any state. Fails if capture is decided before the policy check. **Observe it
  failing** with the `neverWatches` check removed.
- **Every stop condition:** for each of disabled, no consent, menu switch off, Pause All, locked
  and sleeping, `.tick` and `.frontmostChanged` produce no `captureAndRecognize`. Fails if any
  condition is only checked in the runtime. **Observe it failing** for Pause All with its check
  removed.
- **Stale result dropped:** a `.recognized` with an old generation, or for a window that lost focus
  or became never-watched, emits no segment.
- **Redaction:** `sk-`, `ghp_`, `AKIA…`, `Bearer …`, a Luhn-valid 16-digit number and "Your code is
  482913" are masked. A Luhn-invalid 16-digit number, `ben@example.com` and ordinary prose survive.
  Fails if the email rule from `TextRedactor` is inherited, or if card masking ignores Luhn.
  **Observe** the card test failing with the Luhn check removed.
- **Address:** `https://x.com/a?token=abc#frag` becomes `https://x.com/a`. Fails if only `?` is
  handled.
- **Dedupe:** scrolling (lines A B C, then B C D) emits only D. The same window with an identical
  set emits nothing. A new `WindowKey` starts fresh.
- **Budget:** under `.reduced`, the machine never schedules ticks closer than 60 s. With no change,
  no recognition is scheduled.
- **Recogniser** (integration, runs on the macOS CI runner): a bundled fixture PNG of known text is
  recognised to at least 90% of its words by `VisionTextRecognizer`.
- **Nothing leaves the Mac:** in Phase 1, `BacktrackRuntime` has no `CompanionClient` dependency,
  enforced by a test that constructs it without one. `grep -n "CompanionClient" App/BacktrackRuntime.swift`
  returns nothing (expected exit 1).

### 4.5 Verification

```bash
cd apps/trail-marker && xcodegen generate > /tmp/tm-gen.log 2>&1; echo "EXIT=$?"          # expect 0
xcodebuild test -scheme TrailMarker -destination 'platform=macOS' > /tmp/tm-test.log 2>&1; echo "EXIT=$?"   # expect 0
grep -c "Test Suite 'All tests' passed" /tmp/tm-test.log; echo "EXIT=$?"                  # expect 1 line, exit 0
```

**Live proof (the e2e for a native phase), recorded on the PR:** the Debug build installed to
`/Applications` on Ben's Mac, then:

1. Turn Backtrack on, accept consent, and read a web page and a Messages thread. The focus log
   shows segments with the right app and address host.
2. Open 1Password, a private window and a login form. The log shows no Backtrack segment for any
   of them.
3. Show a fake `sk-` key and a test card number, then check the ring in the debugger. Only masked
   forms appear.
4. Use Pause All, the menu switch and a screen lock, one at a time. Segments stop, and the gold dot
   is off.
5. Record a working day's energy use:
   `/usr/bin/top -l 0 -s 60 -pid "$(pgrep -x 'Trail Marker')" -stats cpu > /tmp/tm-cpu.log 2>&1`,
   run during the day and stopped at the end. Report the mean.

## 5. Determinism boundary

- Every UI element renders from state or records, never from model output: the menu rows, the dot,
  the settings status, and later the Moss settings page, storage figures and deletion confirmations.
  Phase 1 has no model at all.
- Backtrack never injects turns into chat. Chat calls `backtrack.search` only when the person asks.
- The model gets exactly two jobs: (1) in Phase 3, answer the person's question from snippets the
  tool returned; (2) in Phase 4, write one day's summary note. Each prompt stays under 150 words of
  guidance.
- Model-authored values crossing into user data happen only in Phase 4 (the note). That note goes
  through a schema with field descriptions, a prompt contract with one worked example, a validator
  (length caps, redaction re-run, no raw line longer than 200 characters copied verbatim), and a
  before/after check that the raw day is deleted only after the note is written and re-read.

## 6. Kill gate (after Phase 1, Ben decides)

Ben runs the Phase 1 Debug build for two working days. The line stops, or goes back to design, if
any of these happens:

- mean CPU above 3%, or battery drain Ben notices;
- recognised text from three of his real "what did I see" moments wouldn't answer the question,
  judged from the Debug ring;
- any unredacted secret or never-watched content appears in the ring.

Phase 2 is planned in detail only after Ben passes this gate.

## 7. Phases 2 to 4 outline (re-planned after the gate)

Seams already verified (research pass at `62ccbb3d2`):

- **Companion route pattern:** `requireCompanion` in `apps/api/src/companion-routes.ts:126-139`.
  Focus routes are the template at `:273-361`, with the owner taken from the credential at
  `:280-282`. Deps are injected via `CompanionRouteDeps` (`:82-86`). Schemas go in
  `packages/shared/src/companion-api.ts`. There is an IP rate limiter (`:62-80`).
- **Module template:** `packages/scratchpad` (manifest, `sql/0216_scratchpads.sql` owner-only RLS
  at `:12-24`, registration `packages/module-registry/src/index.ts:2623-2624`). The highest
  migration number is `0241`.
- **Memory:** `app.memory_chunks.source_kind` CHECK allows only vault/connector/chat/notes
  (`packages/memory/sql/0106:8`). A new `screen` kind needs a **memory-owned** migration.
  Retrieval uses `MemoryRetriever.retrieve` (`packages/memory/src/retrieval.ts:6-32`). Embeddings
  are local (`embedding-provider-config.ts:40`), not routed.
- **Tool template:** `notes.search` (`packages/notes/src/manifest.ts:98-109`,
  `packages/notes/src/tools.ts:22-61`).
- **Jobs:** `registerDataContextWorker` (`packages/jobs/src/pg-boss.ts:375-409`). Payload keys are
  allow-listed in `ALLOWED_PAYLOAD_KEYS` (`:89-165`). Per-user cron follows
  `packages/briefings/src/schedule.ts:50`.
- **Lifecycle:** `dataLifecycle` deletion and export (`packages/module-sdk/src/index.ts:773`,
  template `packages/news/src/data-lifecycle.ts`), plus the cascade test
  `tests/integration/module-data-lifecycle-cascade.test.ts`.
- **Notes folder:** `notes-source-path` (`packages/settings/src/notes-source-routes.ts:24`) and
  `withVaultContextAt` (`packages/vault/src/vault-context.ts:63-108`). The daily chat archive
  (`packages/notes/src/daily-archive-writer.ts:37-88`) is the pattern for the ownership marker and
  the `notes.sync` re-index. It uses raw `fs` (`write-tools.ts:68-110`); **Phase 4 must use
  `VaultContext` instead**, per the hard invariant.

Phase 2 provisional DDL (a decision to review; the number is assigned at build time):

```sql
CREATE TABLE app.backtrack_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  app_name text NOT NULL CHECK (length(app_name) <= 200),
  bundle_id text NOT NULL CHECK (length(bundle_id) <= 255),
  window_title text NOT NULL CHECK (length(window_title) <= 500),
  address text CHECK (length(address) <= 2048),
  body text NOT NULL CHECK (length(body) <= 8192),
  body_hash bytea NOT NULL,
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', window_title || ' ' || coalesce(address,'') || ' ' || body)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, device_id, body_hash, started_at)
);
CREATE INDEX backtrack_segments_owner_time ON app.backtrack_segments (owner_user_id, started_at DESC);
CREATE INDEX backtrack_segments_search ON app.backtrack_segments USING gin (search);
ALTER TABLE app.backtrack_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.backtrack_segments FORCE ROW LEVEL SECURITY;
-- per-verb SELECT/INSERT/DELETE policies on owner_user_id = app.current_actor_user_id();
-- no UPDATE; grants to jarvis_app_runtime only (pattern: 0216:12-24).
```

Open for the Phase 2 planner: whether `device_id` references the companion devices table
(cascade on revoke, or keep rows); the exact `ALLOWED_PAYLOAD_KEYS` addition (`segmentIds`, capped);
and the Moss settings entry point and app-map entries (`packages/shared/src/app-map-core.ts` and
the module manifest), all in the same PR.

## 8. Rulings ledger

- Focus judgments' promised 30-day retention is unenforced: no purge job, no DELETE grant
  (`0240_focus_judgments.sql:34`), and absent from deletion and export. Filed as #2637. This is not
  Backtrack's to fix, but Backtrack must not copy the gap: Phase 2's lifecycle and Phase 4's purge
  are both in scope and tested.
- The companion credential is scoped by construction: only routes that call `requireCompanion`
  accept `tm1_` (`companion-routes.ts:40-43,126-139`). There is no allow-list table to update.
- The module guard rejects the companion credential, so the ingest route is a platform route like
  focus, not a module route (`companion-routes.ts:274-278`).
- Email addresses are kept in Backtrack but stripped in focus judgment (Ben, 2026-09-23). The two
  redactors differ on purpose.
- The Focus-only pause returns under a new key (`focusSwitchedOff`), because `focusPaused` is
  deleted on launch by #2635 (`PreferencesStore.swift:26`).
