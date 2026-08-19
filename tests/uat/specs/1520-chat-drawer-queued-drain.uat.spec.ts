import { test } from "@playwright/test";

// #1520 (1139-C) harness-fit note.
//
// The fix's own regression coverage is tests/e2e/chat-drawer.spec.ts's
// "queued chat drain stays stable across an SSE tick, then sends once after stop" (#1520,
// mocked REST + SSE) — that test passes and is the real proof of the fix. This UAT spec was
// an attempt to additionally prove it against the live backend, and is blocked from running
// for a structural reason that is not a code defect in this PR:
//
// No UAT seed level configures a chat-capable AI provider (see runtime-context.uat.spec.ts's
// header note; tracked as #1121). Traced the real backend to confirm exactly what that means
// here: chat-session-manager.ts's runTurn() calls ensureSession() -> launchSession(), which
// calls persistence.resolveActiveProvider() (chat-session-manager.ts:222-224) and throws "No
// active chat-capable model is configured for this user" BEFORE this.emit() (line 437) ever
// runs. So a turn against an unconfigured actor doesn't just fail to reply -- it never
// publishes ANY transcript record (not even the user's own echo) to the live SSE feed. A
// second, concurrently signed-in browser context sending a real message therefore can never
// produce an observable SSE tick in a sibling session on this harness, no matter how the turn
// is triggered.
//
// A content-free tick (forcing a bare EventSource reconnect via real network toggling, with no
// new published record) was also considered and ruled out: apps/web/src/chat/use-chat-stream.ts
// only calls setRecords() from EventSource's onmessage handler (new content) or the one-time
// history-hydration effect; native EventSource reconnects happen invisibly to React (no onopen
// handler touches state), so a reconnect with zero new content never changes `records`'
// reference at all. Only genuine published content can exercise the bug's mechanism -- and
// that requires a real turn to clear resolveActiveProvider, which #1121 blocks on every level.
//
// This is the same structural gap already documented and test.fixme'd in
// 1089-1090-chat-drawer-private.uat.spec.ts (reason 2) -- adding a "chat" seed chunk with a
// real chat-capable engine is shared seed infrastructure outside this lane's scope.
export const uatLevel = { level: "solo-admin", without: [] } as const;

test.fixme("queued chat drain stays stable across a real SSE tick from a second live session, then sends once after stop (#1520)", async () => {
  // Blocked: no UAT seed level configures a chat-capable AI provider, so no real turn -- from
  // this session or a concurrent second session -- ever clears resolveActiveProvider and
  // publishes a transcript record (see file header). Real proof: tests/e2e/chat-drawer.spec.ts.
});
