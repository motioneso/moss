# PR #2164 r22 security correction — relay continuation

## Task

Implement Fable 5.1's r22 binding ruling on PR #2164 / issue #2159, in this preserved worktree,
branch `fix/2159-sports-retry-card`. Starting head was `0cf62f3fc358e35465799ecf3e558e14425e6bc9`
(confirmed matched `git rev-parse HEAD` when this lane started — still current, nothing else has
landed on this branch).

Full ruling text (already fetched and read in full by the prior session):
`gh api repos/motioneso/moss/issues/comments/5509255706 --jq .body`
(also readable at https://github.com/motioneso/moss/pull/2164#issuecomment-5509255706)

Original task brief: `/home/ben/.coord-briefs/pr2164-r22-security-fix.txt`

**Exactly four files may change** — anything else in the tree is a blocker:
- `packages/chat/src/live/claude-print-chat-engine.ts`
- `packages/chat/src/live/chat-session-manager.ts`
- `tests/unit/claude-print-chat-engine.test.ts`
- `tests/unit/chat-session-manager-mcp-readiness.test.ts`

No live/dev/DB/chat/UAT command, no rebase, no merge, no CI retry. Ordinary push only, at the end.

## What's done

Only `tests/unit/chat-session-manager-mcp-readiness.test.ts` has been edited so far (uncommitted
at relay time — commit it as part of your first task). Added 3 new test cases at the end of the
existing describe block, right after the pre-existing "still bypasses the gate for an
mcp__jarvis__* tool invocation..." test (which was also updated in place to add `toolCallId:
"toolu_bypass1"` to its tool record, matching the shape the real engine will produce post-fix):

1. `"still runs the readiness gate when the only mcp__ activity this turn has no call id"` — item 1
   regression: an `mcp__` tool record with NO `toolCallId` must not count as attachment proof, so
   the readiness gate must still run (and reject, since `getToolsListObservationCount` never
   advances past baseline in this test).
2. `"suppresses the rejection-signal record from emitted activity but still emits a native tool's
   own errored result"` — item 2 regression: a pure rejection-signal record (`kind: "tool",
   toolCallId, rejected: true`, no `toolName`) must NOT be forwarded to `manager.subscribe(...)`
   subscribers, but a native tool's own record (`kind: "tool", toolName: "Read"`) must still be
   emitted. Uses `manager.subscribe("u1", (record) => emitted.push(record))` — NOT
   `manager.on("activity", ...)`, which does not exist on `ChatSessionManager` (only `subscribe`
   does; verified in source at `chat-session-manager.ts:736`).

**These tests have NOT been run yet.** They should currently be RED (the source fixes below are
not yet implemented) — confirm that before implementing, per the binding gate order.

## What's left — do these in order

### 1. Read the ruling sections you need (don't re-read the whole thing if avoidable)

Sections 1, 2, 3, 5 (allowlist), and 6 (gate order) of the ruling comment are the operative ones.
Re-fetch with `gh api repos/motioneso/moss/issues/comments/5509255706 --jq .body` if you need the
exact wording; the summary below is accurate but the ruling is authoritative on exact phrasing.

### 2. Implement `packages/chat/src/live/claude-print-chat-engine.ts`

**Item 1 (seam fix):** in `readNew` (around line 232-237), the map from `parsed.events` to
`records` currently only copies `kind`, `text`, `toolName` — drop `toolCallId` and `rejected`.
Carry them through, optional-spread style (matching `transcript-reader.ts:265`'s
`...(id ? { toolCallId: id } : {})` pattern):

```ts
const records: TranscriptRecord[] = parsed.events.map((event) => ({
  kind: event.kind as ChatRecordKind,
  text: event.text,
  toolName: event.toolName,
  ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
  ...(event.rejected ? { rejected: event.rejected } : {})
}));
```

No other change to `readNew`. `TranscriptRecord` (in `types.ts`, NOT on the allowlist, but already
has these optional fields from r21 — do not edit that file) and `ChatActivityEventWithToolName` (in
`transcript-reader.ts`, also not on the allowlist, also already carries these fields from r21) both
already support this — confirmed by reading both files in full during the prior session.

**Item 3 (fragment-safe prompt scrub):** `getLastSubmitDiagnostics()` (around line 130-139)
currently does `redactExact(redactExact(redactSecrets(stderr), neutralDir), currentSubmitPrompt)` —
the last `redactExact` is a whole-literal replace, which does nothing against a stderr line that
contains only a FRAGMENT of a too-long prompt (the normal case, since prompts routinely exceed the
4096-byte stderr cap).

Replace the whole-prompt `redactExact` call with a new fragment-safe scrub, entirely inside this
file:

```ts
const PROMPT_FRAGMENT_SCRUB_WINDOW = 32;

function scrubPromptFragments(stderrTail: string, sanitizedPrompt: string): string {
  if (sanitizedPrompt.length < PROMPT_FRAGMENT_SCRUB_WINDOW) {
    return redactExact(stderrTail, sanitizedPrompt);
  }
  const windows = new Set<string>();
  for (let i = 0; i <= sanitizedPrompt.length - PROMPT_FRAGMENT_SCRUB_WINDOW; i++) {
    windows.add(sanitizedPrompt.slice(i, i + PROMPT_FRAGMENT_SCRUB_WINDOW));
  }
  return stderrTail
    .split("\n")
    .filter((line) => {
      for (const window of windows) {
        if (line.includes(window)) return false;
      }
      return true;
    })
    .join("\n");
}
```

Then in `getLastSubmitDiagnostics`:

```ts
const scrubbed = scrubPromptFragments(
  redactExact(redactSecrets(this.lastSubmitStderr), this.launchOpts?.neutralDir),
  this.currentSubmitPrompt
);
```

Rules from the ruling (already reflected above, restated for verification):
- Keep `redactSecrets` and the exact `neutralDir` scrub exactly as they are — only the prompt scrub
  changes.
- Drop the WHOLE line if it contains any 32-char window of the sanitized prompt. Do not
  partially rewrite the line.
- If the sanitized prompt is shorter than 32 chars, fall back to the old exact-literal scrub
  (`redactExact`) — this keeps short-prompt behavior (and the existing `jst_`-straddle test, whose
  submitted prompt is `"hello"`, well under 32 chars) unchanged.
- No new dependency, no change to `redact.ts` (not on the allowlist anyway), no change to the
  4096-byte cap or the leading-partial-line drop logic already in `submit()`.

**Docstring:** the ruling also requires updating the class-level docstring on
`getLastSubmitDiagnostics` (currently says the prompt is "scrubbed out via `redactExact`") to
describe the containment/fragment scrub honestly instead.

**Existing test likely needs updating, not just added to:** the current test `"scrubs the current
turn's prompt text out of a stderr tail that echoes it"` (around line 540 in
`claude-print-chat-engine.test.ts`) writes ONE stderr line that contains both the full prompt AND
the string `"command failed"`, then asserts `stderrTail` contains `"command failed"`. Under the
new whole-line-drop behavior, that whole line (prompt + "command failed" together) gets dropped
entirely, so that assertion will now fail — this is expected and correct per the new design, not a
regression. **Fix this test**, don't leave it red: split the stderr write into two separate lines —
one line that echoes the prompt (for the leak-check assertions), and a second, separate line
containing `"command failed"` (unrelated to the prompt, survives the scrub). Keep the
not-toContain(promptText) / not-toContain(fragment) assertions; keep the toContain("command
failed") assertion, just move it to its own line so it's not collapsed into the dropped line.
Judgment call made by the prior session, reasoned through carefully — see the "full-prompt case"
language in ruling section 3's regression-check item 3, which is otherwise contradictory with
whole-line-drop unless the two concerns are put on separate lines in the fixture.

### 3. Implement `packages/chat/src/live/chat-session-manager.ts`

Both changes are inside the `for (const record of records)` loop and the `mcpToolInvoked`
computation right after it (currently around lines 458-467 and 512 — re-check exact line numbers
before editing, they may have shifted slightly from the read the prior session did).

**Item 2 (suppress rejection-signal emission):** currently every record is unconditionally
emitted via `this.emit(actorUserId, surface, record)` at the top of the loop body. Change to
suppress only the pure rejection-signal shape (no `toolName`):

```ts
for (const record of records) {
  const isRejectionSignal = record.kind === "tool" && record.rejected === true && !record.toolName;
  if (!isRejectionSignal) this.emit(actorUserId, surface, record);
  if (record.kind === "reply") reply = record.text;
  if (record.kind === "tool" && record.toolName) {
    invokedToolNames.add(record.toolName);
    if (record.toolName.startsWith("mcp__"))
      mcpAttempts.push({ name: record.toolName, id: record.toolCallId });
  }
  if (record.kind === "tool" && record.rejected && record.toolCallId)
    rejectedCallIds.add(record.toolCallId);
}
```

(Bookkeeping — `invokedToolNames`, `mcpAttempts`, `rejectedCallIds` — is unchanged; only the
`this.emit(...)` call gets gated.)

**Item 1 (require a call id for attachment proof):** the `mcpToolInvoked` line right after the
loop currently reads:

```ts
const mcpToolInvoked = mcpAttempts.some((a) => !(a.id && rejectedCallIds.has(a.id)));
```

This is backwards for an id-less attempt: `!(undefined && ...)` is `true`, so a call with no id
silently counts as proof of attachment. Fix to require the id:

```ts
const mcpToolInvoked = mcpAttempts.some((a) => a.id !== undefined && !rejectedCallIds.has(a.id));
```

Nothing else in this file changes. `transcript-reader.ts`, `cli-chat-engine.ts`, `types.ts`,
`session-tokens.ts`, `runtime.ts`, `routes.ts` etc. are all explicitly forbidden — do not touch
them even if you notice related issues (item 2's ruling text explicitly says `cli-chat-engine.ts`
has the same blank-record bug on the tmux path and explicitly declines to fix it there).

### 4. Add the two required regression tests to `tests/unit/claude-print-chat-engine.test.ts`

Item 1 seam test(s) — drive a REAL `ClaudePrintChatEngine.readNew()` (not a fake) over a
transcript fixture. Pattern to follow (matches existing tests in this file, e.g. "reads Claude
transcript JSONL through the existing parser" around line 222, and "carries toolName through
readNew..." around line 444):

- Assistant record: `{ type: "assistant", message: { role: "assistant", stop_reason: "tool_use",
  content: [{ type: "tool_use", id: "toolu_seam1", name: "mcp__jarvis__sports_retry_source",
  input: {} }] } }`
- User record (rejection): `{ type: "user", message: { role: "user", content: [{ type:
  "tool_result", tool_use_id: "toolu_seam1", is_error: true }] } }`

Write ONE test where both lines are present in a single `readNew(0)` call, asserting the tool
record carries `toolCallId: "toolu_seam1"` and a separate rejection record carries `toolCallId:
"toolu_seam1", rejected: true`. Write a SECOND test that splits this across two `readNew` calls at
different offsets (poll 1 sees only the tool_use line and gets `toolCallId` on the tool record;
mutate `io.writes[transcriptPath]` to append the rejection line; poll 2 with the offset returned
from poll 1 sees only the new rejection record) — this is the cross-poll case the ruling explicitly
calls out as under-tested today.

Item 3 fragment-scrub tests — three required by the ruling:
1. A realistic argv-echo stderr line containing a FRAGMENT (not the whole thing) of a prompt
   longer than 4096 bytes → resulting `stderrTail` has no 32+-char substring of that prompt.
   (Build a long `sanitizedPrompt` via `submit()`, then `currentChild.stderr.write(...)` a line
   containing some middle slice of that prompt plus surrounding text.)
2. A stderr line unrelated to the prompt (e.g. `bash: claude: command not found`) on its own line
   → survives the scrub untouched.
3. The existing `jst_`-at-the-seam test and the (now-adjusted, see step 2 above) full-prompt test
   still pass.

### 5. Binding gate order (from ruling section 6 — follow exactly, in order)

1. `pnpm audit:preflight` exits 0. (Already confirmed once by the prior session at the unmodified
   starting head — exit 0. Re-run is cheap; not required to repeat but doesn't hurt.)
2. Confirm the item-1 seam test and item-3 fragment test are seen FAILING before your source
   edits, then implement, then confirm ALL four files' named tests pass.
3. Run **only** the scoped static/unit verification through the `verify-gate` skill — invoke that
   skill, don't hand-roll the command, and don't pipe its output (piping masks the exit code — a
   repo hook here already blocks pipes into gate commands, so this should self-enforce).
4. Confirm `git status`/`git diff --stat` shows EXACTLY these four files changed, nothing else.
5. Commit with exact file staging (`git add <path>` per file, never `-A`/`.`, never bare
   `git commit`) — this repo's CLAUDE.md requires the `shared-checkout` skill for any commit here
   since other sessions may share this worktree; use it.
6. Ordinary push of the existing branch (`git push`, no `--force`, no rebase first — the ruling
   explicitly forbids rebase here).

### 6. Report back

Report to the coordinator (agent name `coordinator`, currently pane `w1:pAZ` but re-resolve fresh
by name — pane numbers reflow) via `herdr-pane-message`, signed with your own pane id:
- the new full commit SHA
- red and green test commands/exit codes (the seam test and fragment test specifically, seen
  failing then passing)
- verify-gate exit code
- the exact 4 changed files (confirm via `git diff --stat` or `git show --stat`)
- file:line citations for the fix corresponding to each of the three QA blockers (item 1, item 2,
  item 3 above)

No live-path work, no merge, no CI retry — those are explicitly out of scope for this lane per
both the ruling and the original task brief at `/home/ben/.coord-briefs/pr2164-r22-security-fix.txt`.

## Notes / things ruled out already (don't re-litigate)

- Item 4 (non-blocking findings: console.error logger, reply-before-gate-throws ordering, dead
  `waitForToolsListObservedSince`, stale UAT banner) — **none of these are in scope.** The ruling
  explicitly keeps all four out. Do not touch `session-tokens.ts`, do not wire a logger, do not
  reorder the emit/gate-throw sequence, do not touch `tests/uat/provisioner.ts`.
- Persistence/freshness/`invokedToolNames`/`resolveChatFreshness` are explicitly unchanged by this
  ruling — don't "fix" the known rejected-call-marks-fresh consequence, it's out of scope here.
