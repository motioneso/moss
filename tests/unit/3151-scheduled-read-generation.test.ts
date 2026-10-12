import { afterEach, expect, it, vi } from "vitest";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import { createScheduledReadResolver } from "../../packages/chat/src/scheduled-reads/generation.js";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), route: vi.fn(), candidates: vi.fn() }));
vi.mock("@moss/ai", () => ({
  AiRepository: class {
    resolveModelForService = mocks.route;
  },
  createAiSecretCipher: vi.fn(),
  prepareStructuredGeneration: mocks.prepare
}));
vi.mock("@moss/tasks", () => ({ listOwnedTasksForScheduledRead: mocks.candidates }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function fixture() {
  mocks.route.mockResolvedValue({ model: { id: "model" } });
  mocks.candidates.mockResolvedValue([{ id: "item", title: "PRIVATE SOURCE" }]);
  return createScheduledReadResolver({
    dataContext: {
      withDataContext: async (_ctx: unknown, work: (db: DataContextDb) => Promise<unknown>) =>
        work({} as DataContextDb)
    } as DataContextRunner,
    resolveActiveModules: async () => [
      {
        id: "tasks",
        name: "Tasks",
        version: "1.0.0",
        publisher: "Moss",
        lifecycle: "required",
        compatibility: { jarv1s: "*" }
      }
    ],
    createCliStructuredAdapter: vi.fn()
  });
}

it("records the structured failure class and stage without provider content", async () => {
  const resolve = fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.prepare.mockResolvedValue(async () => ({
    ok: false,
    error: "validation_failed",
    reason: "json_parse"
  }));
  expect(
    await resolve("owner", "Check my private task in 30 seconds", new AbortController().signal)
  ).toMatchObject({ taskId: null });
  expect(warn).toHaveBeenCalledWith(
    JSON.stringify({
      event: "chat.scheduled_read_refused",
      stage: "json_parse",
      errorClass: "validation_failed"
    })
  );
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/PRIVATE|private|owner|model/);
});

it("records the stage of an exception without its message or arbitrary name", async () => {
  const resolve = fixture();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = new Error("PRIVATE PROMPT AND SECRET");
  error.name = "PRIVATE OUTPUT";
  mocks.prepare.mockRejectedValue(error);
  expect(
    await resolve("owner", "Check my private task in 30 seconds", new AbortController().signal)
  ).toMatchObject({ taskId: null });
  expect(warn).toHaveBeenCalledExactlyOnceWith(
    JSON.stringify({ event: "chat.scheduled_read_refused", stage: "prepare", errorClass: "Error" })
  );
});
