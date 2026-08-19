import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDebouncedPageContextSync } from "../../apps/web/src/chat/use-page-context-sync.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("keeps the minimum interval across a route resubscribe", async () => {
  const state = { lastUploadAt: Number.NEGATIVE_INFINITY };
  const upload = vi.fn().mockResolvedValue(undefined);
  const createSync = () =>
    createDebouncedPageContextSync({
      capture: () => ({ route: "/news" }) as never,
      upload,
      delayMs: 250,
      minIntervalMs: 5_000,
      state
    });

  let sync = createSync();
  sync.schedule();
  await vi.advanceTimersByTimeAsync(250);
  expect(upload).toHaveBeenCalledTimes(1);

  sync.stop();
  sync = createSync();
  sync.schedule();
  await vi.advanceTimersByTimeAsync(250);
  expect(upload).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(4_750);
  expect(upload).toHaveBeenCalledTimes(2);
  sync.stop();
});

it("debounces repeated changes into one snapshot upload", async () => {
  const upload = vi.fn().mockResolvedValue(undefined);
  const sync = createDebouncedPageContextSync({
    capture: () => ({ route: "/news" }) as never,
    upload,
    delayMs: 250
  });
  sync.schedule();
  sync.schedule();
  await vi.advanceTimersByTimeAsync(249);
  expect(upload).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(upload).toHaveBeenCalledTimes(1);
  sync.stop();
});

it("caps uploads while the page keeps changing", async () => {
  const upload = vi.fn().mockResolvedValue(undefined);
  let revision = 0;
  const sync = createDebouncedPageContextSync({
    capture: () => ({ route: `/news/${revision++}` }) as never,
    upload,
    delayMs: 250,
    minIntervalMs: 5_000
  });

  for (let elapsed = 0; elapsed < 10_000; elapsed += 500) {
    sync.schedule();
    await vi.advanceTimersByTimeAsync(500);
  }

  expect(upload).toHaveBeenCalledTimes(2);
  sync.stop();
});

it("logs rejected uploads without retrying", async () => {
  const upload = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const sync = createDebouncedPageContextSync({
    capture: () => ({ route: "/news" }) as never,
    upload,
    delayMs: 250,
    minIntervalMs: 5_000
  });

  sync.schedule();
  await vi.advanceTimersByTimeAsync(250);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("page context"), expect.anything());

  await vi.advanceTimersByTimeAsync(10_000);
  expect(upload).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  sync.stop();
  warn.mockRestore();
});
