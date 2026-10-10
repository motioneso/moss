// #3195: a delivered reminder reaches only its owner's drawer, and only while that drawer shows
// the owner's Main thread. Each guard below has a case that fails when the guard is removed.

import { describe, expect, it } from "vitest";

import {
  routeMainBackgroundMessage,
  type BackgroundRecord,
  type ShownDrawerThread
} from "../../packages/chat/src/live/background-message-routing.js";
import { surfaceSessionKey } from "../../packages/chat/src/live/chat-surface.js";
import type { OriginThreadTransition } from "../../packages/chat/src/live/origin-record-routing.js";
import type { TranscriptRecord } from "../../packages/chat/src/live/types.js";

const reminder: BackgroundRecord = {
  kind: "reply",
  text: "Reminder: stretch",
  messageId: "reminder-1",
  background: true
};

const drawerKey = surfaceSessionKey("user-1", "drawer");
const switching = (): OriginThreadTransition => ({
  version: 1,
  pending: 1,
  settled: Promise.resolve()
});

async function route(
  over: {
    shown?: ShownDrawerThread;
    transitions?: Map<string, OriginThreadTransition>;
    onShownRead?: () => void;
  } = {}
) {
  const emitted: { surface: string; record: TranscriptRecord }[] = [];
  const asked: string[] = [];
  await routeMainBackgroundMessage({
    actorUserId: "user-1",
    mainThreadId: "main-1",
    record: reminder,
    shown: async (actorUserId) => {
      asked.push(actorUserId);
      over.onShownRead?.();
      return over.shown ?? { incognito: false, threadId: "main-1" };
    },
    transitions: over.transitions ?? new Map(),
    emit: (surface, record) => emitted.push({ surface, record })
  });
  return { emitted, asked };
}

describe("routeMainBackgroundMessage", () => {
  it("shows the reminder on the owner's drawer while it shows Main", async () => {
    expect(await route()).toEqual({
      emitted: [{ surface: "drawer", record: reminder }],
      asked: ["user-1"]
    });
  });

  it("does not show it while the drawer shows a side chat", async () => {
    const { emitted } = await route({ shown: { incognito: false, threadId: "side-1" } });
    expect(emitted).toEqual([]);
  });

  it("does not show it while the drawer shows no chat", async () => {
    expect((await route({ shown: { incognito: false } })).emitted).toEqual([]);
  });

  it("does not show it in a private chat", async () => {
    const { emitted } = await route({ shown: { incognito: true, threadId: "main-1" } });
    expect(emitted).toEqual([]);
  });

  it("does not show it while the drawer is switching chats", async () => {
    const transitions = new Map([[drawerKey, switching()]]);
    expect((await route({ transitions })).emitted).toEqual([]);
  });

  it("does not show it when a switch starts while the shown chat is read", async () => {
    const transitions = new Map<string, OriginThreadTransition>();
    const { emitted } = await route({
      transitions,
      onShownRead: () => transitions.set(drawerKey, switching())
    });
    expect(emitted).toEqual([]);
  });
});
