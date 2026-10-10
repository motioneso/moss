// #3195: a delivered reminder reaches only its owner's drawer, and only while that drawer shows
// the owner's Main thread. Each guard below has a case that fails when the guard is removed.

import { describe, expect, it } from "vitest";

import { routeMainBackgroundMessage } from "../../packages/chat/src/live/background-message-routing.js";
import type { UserSession } from "../../packages/chat/src/live/chat-session-provider-identity.js";
import { surfaceSessionKey } from "../../packages/chat/src/live/chat-surface.js";
import type { OriginThreadTransition } from "../../packages/chat/src/live/origin-record-routing.js";
import type { TranscriptRecord } from "../../packages/chat/src/live/types.js";

const reminder: TranscriptRecord = {
  kind: "reply",
  text: "Reminder: stretch",
  messageId: "reminder-1",
  background: true
};

function session(over: Partial<UserSession> = {}): UserSession {
  return {
    actorUserId: "user-1",
    surface: "drawer",
    threadId: "main-1",
    incognito: false,
    ...over
  } as UserSession;
}

function route(
  over: {
    sessions?: Map<string, UserSession>;
    transitions?: Map<string, OriginThreadTransition>;
    drawerThreadId?: string | null;
    record?: TranscriptRecord;
    actorUserId?: string;
  } = {}
) {
  const emitted: { surface: string; record: TranscriptRecord }[] = [];
  const delivered = routeMainBackgroundMessage({
    actorUserId: over.actorUserId ?? "user-1",
    mainThreadId: "main-1",
    drawerThreadId: over.drawerThreadId === undefined ? "main-1" : over.drawerThreadId,
    record: over.record ?? reminder,
    sessions: over.sessions ?? new Map(),
    transitions: over.transitions ?? new Map(),
    emit: (surface, record) => emitted.push({ surface, record })
  });
  return { delivered, emitted };
}

const drawerKey = surfaceSessionKey("user-1", "drawer");

describe("routeMainBackgroundMessage", () => {
  it("shows the reminder on a drawer whose live session is on Main", () => {
    const result = route({ sessions: new Map([[drawerKey, session()]]), drawerThreadId: null });
    expect(result).toEqual({ delivered: true, emitted: [{ surface: "drawer", record: reminder }] });
  });

  it("shows the reminder on a drawer with no session whose current thread is Main", () => {
    expect(route().emitted).toEqual([{ surface: "drawer", record: reminder }]);
  });

  it("does not show it on a drawer whose live session is on a side chat", () => {
    const sessions = new Map([[drawerKey, session({ threadId: "side-1" })]]);
    expect(route({ sessions })).toEqual({ delivered: false, emitted: [] });
  });

  it("does not show it on a drawer with no session whose current thread is a side chat", () => {
    expect(route({ drawerThreadId: "side-1" })).toEqual({ delivered: false, emitted: [] });
  });

  it("does not show it in a private chat", () => {
    const sessions = new Map([[drawerKey, session({ incognito: true })]]);
    expect(route({ sessions })).toEqual({ delivered: false, emitted: [] });
  });

  it("does not show it while the drawer is switching chats", () => {
    const transitions = new Map([
      [drawerKey, { version: 1, pending: 1, settled: Promise.resolve() }]
    ]);
    expect(route({ transitions })).toEqual({ delivered: false, emitted: [] });
  });

  it("does not show it through a session that belongs to someone else", () => {
    const sessions = new Map([[drawerKey, session({ actorUserId: "user-2" })]]);
    expect(route({ sessions })).toEqual({ delivered: false, emitted: [] });
  });

  it("only routes stored background replies", () => {
    for (const record of [
      { ...reminder, background: undefined },
      { ...reminder, messageId: undefined },
      { ...reminder, kind: "status" as const }
    ]) {
      expect(route({ record })).toEqual({ delivered: false, emitted: [] });
    }
  });
});
