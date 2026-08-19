# Plan — #900 + #1134: mic error classification and track cleanup (Wave 6 lane B)

**Spec:** `docs/superpowers/specs/2026-08-09-wave-6-secure-context-and-weather.md` (Lane B)
**Issues:** #900 (task), #1134 (bug) — both children of #869, no new task issue required (spec
Process gates)
**Tier:** `routine` — CI gate + `/code-review` + exit-criteria, auto-merge after green
**Owned surface (exclusive):** `apps/web/src/chat/composer.tsx`

## 0. Gates

- Spec approved 2026-08-09 (Ben). ✅
- #900 carries the `task` label; #1134 carries `bug` — spec's Process Gates section states no new
  task issue is required for either. ✅

## 1. Seams check (file:line citations)

- `startRecording` currently swallows the caught error with a bare `catch {}` and always sets the
  same generic message — `apps/web/src/chat/composer.tsx:292-314` (catch at 310-313).
- `navigator.mediaDevices.getUserMedia` is called unconditionally with no pre-check for
  `navigator.mediaDevices === undefined` — `apps/web/src/chat/composer.tsx:295`.
- Track release only happens inside `recorder.onstop` (`apps/web/src/chat/composer.tsx:301-302`),
  which only fires when `stopRecording()` (`composer.tsx:316-320`) calls `recorder.stop()`. There is
  no cleanup effect for unmount — confirmed by reading the full effect list (`composer.tsx:84-90`,
  `115-120`, `200-208`) — none references `recorderRef` or a stream. This is the #1134 leak.
- `mergeTranscriptIntoText` is already a co-located pure export at `composer.tsx:526`, proving the
  established pattern of exporting a pure helper from `composer.tsx` itself (not a new file) for
  something the mic control needs unit-tested — `apps/web/src/chat/attachments.ts:1-13` explicitly
  cites this as the model to mirror.
- Existing test file `tests/unit/chat-composer-voice.test.tsx` already imports `Composer` and
  `mergeTranscriptIntoText` from `composer.js` and documents (lines 76-80) that this project's
  vitest environment is **node, not jsdom**, so `MediaRecorder`/DOM interaction tests were
  previously out of reach — it fell back to a source-text "guard" test instead of an executable one.
- `vitest.config.ts:298-311` confirms the environment is unset (defaults to `node`) and the test
  include globs cover `tests/unit/**/*.test.tsx`.
- `vi.stubGlobal("navigator", { sendBeacon })` is an existing, working pattern for replacing
  `navigator` wholesale in this exact node test environment —
  `tests/unit/api-timezone-request.test.ts:65`. This unblocks writing a real (non-source-guard) test
  for #1134: stub `navigator.mediaDevices.getUserMedia` and the global `MediaRecorder` constructor,
  drive the mic button through `react-test-renderer`'s `act`, and assert on fake-track `stop()`
  calls — the same `act`/`create`/`unmount` pattern already proven against a different composer at
  `tests/unit/assistant-surface-composer.test.tsx:1-4,47-65` (no jsdom needed — `react-test-renderer`
  never touches a DOM).
- `DOMException` is a Node global (stable since Node 18) — usable directly in test code to construct
  `NotAllowedError` / `NotFoundError` / etc. without a browser.
- Node's own `navigator` global (present, no `mediaDevices`) means the "insecure origin" branch is
  exercisable even without stubbing anything, but the plan stubs `navigator` explicitly in every
  test for determinism rather than relying on the ambient Node global.

**Open question: none.** Every capability the plan below assumes has a citation above.

## 2. Design — the determinism boundary

This is a pure client-side UI fix; no model/AI turn is involved. No new prop is model-authored. Not
applicable beyond noting it: N/A.

## 3. Decisions (signatures, strings, test cases — no bodies)

### 3.1 `apps/web/src/chat/composer.tsx` — new pure export

```ts
export function classifyMicError(error: unknown, mediaDevicesAvailable: boolean): string;
```

Exact returned strings (verbatim from #900's body):

| Condition                                                                                                  | Returned string                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `mediaDevicesAvailable === false`                                                                          | `"Voice input needs a secure connection (HTTPS). You're on an insecure origin."`                                  |
| `error instanceof DOMException && (error.name === "NotAllowedError" \|\| error.name === "SecurityError")`  | `"Microphone permission was denied. Enable it in your browser settings."`                                         |
| `error instanceof DOMException && (error.name === "NotFoundError" \|\| error.name === "NotReadableError")` | `"No microphone found."`                                                                                          |
| anything else                                                                                              | `"Microphone access was denied or unavailable."` (unchanged existing generic string — fallback, not a regression) |

### 3.2 `apps/web/src/chat/composer.tsx` — `startRecording` (composer.tsx:292-314)

- Compute `mediaDevicesAvailable` via `typeof navigator.mediaDevices?.getUserMedia === "function"`
  **before** the try block; if false, call `setMicError(classifyMicError(undefined, false))` and
  `return` without calling `getUserMedia` (avoids the `TypeError` #900 describes).
- Bind the catch parameter (`catch (error)` — currently unbound `catch {}`) and call
  `setMicError(classifyMicError(error, true))`.
- On success, in addition to the existing `recorderRef.current = recorder`, store the acquired
  stream in a new ref: `streamRef.current = stream`.

### 3.3 `apps/web/src/chat/composer.tsx` — new ref + cleanup effect (#1134)

- New ref beside `recorderRef` (composer.tsx:103): `const streamRef = useRef<MediaStream | null>(null);`
- `recorder.onstop` (composer.tsx:301-306) additionally clears `streamRef.current = null` after
  stopping tracks (hygiene — the stream is already released at that point via the existing loop).
- New mount-only effect (empty deps) whose **cleanup** stops every track on the still-live stream:
  ```ts
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  ```
  This runs on unmount (drawer close) regardless of whether `stopRecording` was ever called — it
  does not call `recorder.stop()` (which would fire `onstop` → `transcribeAndInsert` → `setState`
  after unmount); it only releases the hardware.

### 3.4 No other files change

`stopRecording`, `transcribeAndInsert`, `mergeTranscriptIntoText`, and all rendering/JSX are
untouched. `micDisabled`/`micTitle` logic is untouched.

## 4. Test plan — `tests/unit/chat-composer-voice.test.tsx` (extend, don't replace)

All new tests execute (not source-guards). Each states the behavior and why it fails today.

**A. `classifyMicError` (#900) — pure, no rendering:**

1. `classifyMicError(undefined, false)` → insecure-origin string. Fails today because the function
   does not exist / current code never distinguishes this case.
2. `classifyMicError(new DOMException("x", "NotAllowedError"), true)` → permission-denied string.
3. `classifyMicError(new DOMException("x", "SecurityError"), true)` → permission-denied string
   (same bucket as #2 — proves the `||` branch, not just one arm).
4. `classifyMicError(new DOMException("x", "NotFoundError"), true)` → "No microphone found."
5. `classifyMicError(new DOMException("x", "NotReadableError"), true)` → "No microphone found."
6. `classifyMicError(new Error("weird"), true)` → generic fallback string — proves the fallback
   still exists for an unclassified error and #2-5 didn't swallow it.

**B. Interactive lifecycle (#900 insecure branch + #1134 cleanup) — `react-test-renderer`, stubbed
globals, new `describe` block:**

Shared setup: `vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } })` per test (swap the
`getUserMedia` mock per case); a minimal fake `MediaRecorder` class stubbed via
`vi.stubGlobal("MediaRecorder", FakeRecorder)` with settable `ondataavailable`/`onstop`, a no-op
`start()`, and `mimeType = "audio/webm"`. `vi.unstubAllGlobals()` in `afterEach`.

7. **Insecure origin, no `mediaDevices`:** stub `navigator` with no `mediaDevices` key at all; spy
   `getUserMedia = vi.fn()` is asserted **not called**; click the mic button (via
   `micButton.props.onClick()` inside `act`); assert the rendered `form-error` text equals the
   insecure-origin string. Fails today: current code calls `getUserMedia` unconditionally and
   throws before reaching any `mediaDevices`-aware branch.
8. **Track cleanup on unmount mid-recording (#1134's exit criterion):** `getUserMedia` resolves a
   fake `MediaStream`-shaped object exposing `getTracks()` returning two fake tracks
   (`{ stop: vi.fn() }` each); click the mic button and flush the microtask queue inside `act` so
   `startRecording` completes and `recording` becomes true (assert via the mic button's
   `aria-label` flipping to `"Stop recording"`); call `renderer.unmount()`; assert **both** fake
   tracks' `stop` mock was called exactly once. Fails today: no unmount cleanup effect exists, so
   `stop()` is never called and the mic stays hot.
9. **No-op safety:** mount the composer, unmount immediately without ever starting a recording;
   assert `renderer.unmount()` does not throw (guards the `streamRef.current?.` optional chain
   against a null stream).

**Existing tests in the file (mic-disabled-by-capability-route, the #738 no-auto-send source guard)
are unchanged and must keep passing** — they cover surface this plan does not touch.

## 5. Verification commands

```bash
pnpm --filter @moss/web typecheck > /tmp/w6b-typecheck.log 2>&1; echo "EXIT=$?"   # expect 0
pnpm exec vitest run tests/unit/chat-composer-voice.test.tsx > /tmp/w6b-vitest.log 2>&1; echo "EXIT=$?"  # expect 0
```

Full gate (`coordinated-wrap-up`, isolated gate DB) runs at wrap-up, not here.

## 6. Live-path proof (binds this PR — routine tier does not exempt it)

- **#900:** open the dev instance over LAN HTTP (not `localhost`) from a second device or a
  browser profile with the origin flagged insecure; click the mic button; screenshot the rendered
  error reading "needs a secure connection (HTTPS)"; then confirm on `localhost` the mic still
  requests permission and records normally (unregressed).
- **#1134:** on a browser that grants mic permission, start recording, close the chat drawer
  mid-recording, and screenshot the browser tab/address-bar recording indicator clearing.
- Both go into a single `gh pr comment` per the Live-Path Gate. If the LAN-HTTP or real-hardware mic
  step is unreachable from this environment, report **code-complete, unverified** rather than
  "done."

## 7. Kill gate

Single-phase lane (one file, two small issues) — no phase 2 to gate. If the interactive
`react-test-renderer` + `vi.stubGlobal` approach in §4.B turns out not to execute in this repo's
vitest environment (contradicting the seam citations in §1), the fallback is: ship #900's pure
helper + unit tests (real coverage) and #1134's code fix with a source-guard test only (matching the
existing file's precedent at `composer-voice.test.tsx:81-96`), and say so explicitly in the PR
description rather than silently downgrading the claim. **Owner of that call: this lane's build
agent, reported to the coordinator before wrap-up if it triggers.**

## 8. Rulings ledger

- Pure helper lives in `composer.tsx` itself (not a new file), matching `mergeTranscriptIntoText`'s
  precedent and `attachments.ts`'s explicit comment pointing at it as the model to mirror.
- Track cleanup stops tracks directly via a stored `MediaStream` ref rather than calling
  `recorder.stop()` on unmount, to avoid firing `onstop` → `transcribeAndInsert` → `setState` after
  the component has already unmounted.
- Test file is extended in place (`tests/unit/chat-composer-voice.test.tsx`), not split, since it
  already owns this exact surface and its own comments anticipated exactly this next step.
