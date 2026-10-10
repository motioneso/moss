import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@moss/db", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  assertDataContextDb: () => undefined
}));

import { ChatRepository } from "../../packages/chat/src/repository.js";
import { chatListTodaysTurnsExecute } from "../../packages/chat/src/tools.js";

const NOW = new Date("2026-07-03T12:00:00.000Z");

function message(index: number) {
  // One message per minute, oldest first, all inside the 36h window.
  return {
    role: "user",
    status: "stored",
    body: `turn-${index}`,
    created_at: new Date(NOW.getTime() - (100 - index) * 60_000)
  };
}

describe("chatListTodaysTurnsExecute", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the newest turns when the window holds more than the cap", async () => {
    vi.useFakeTimers({ now: NOW });
    vi.spyOn(ChatRepository.prototype, "listThreadsByActivity").mockResolvedValue([
      { id: "t1", title: "Thread", incognito: false }
    ] as never);
    vi.spyOn(ChatRepository.prototype, "listMessages").mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => message(i)) as never
    );

    const result = await chatListTodaysTurnsExecute({} as never, {}, {} as never);
    const turns = (result as { data: { turns: { excerpt: string }[] } }).data.turns;

    expect(turns).toHaveLength(40);
    expect(turns[0]?.excerpt).toBe("turn-60");
    expect(turns[39]?.excerpt).toBe("turn-99");
  });
});
