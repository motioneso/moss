/**
 * Admin alerts for tool updates (#2689 slice 4): plain words, one per toolset, version, kind and
 * day, and never the raw check output.
 */
import { describe, expect, it, vi } from "vitest";

import {
  buildCliToolAlertRaiser,
  buildCliVersionTooOldHandler,
  cliToolAlertCopy,
  cliToolAlertKey
} from "../../packages/module-registry/src/cli-tools-alerts.js";

describe("cliToolAlertCopy", () => {
  it("explains a held back update in plain words from the fixed reason list", () => {
    const copy = cliToolAlertCopy({
      kind: "held_back",
      provider: "anthropic",
      version: "2.1.290",
      reason: "tool_call_missing"
    });
    expect(copy.title).toBe("Claude update 2.1.290 was held back");
    expect(copy.body).toContain("couldn't use Moss's tools in a test chat");
    expect(copy.body).toContain("press Retry");
  });

  it("never echoes a raw reason", () => {
    const copy = cliToolAlertCopy({
      kind: "held_back",
      provider: "openai-compatible",
      reason: "ERR sk-secret <b>boom</b>"
    });
    expect(copy.body).not.toContain("sk-secret");
    expect(copy.body).toContain("failed its check");
  });

  it("covers the cannot-check and too-old cases", () => {
    expect(cliToolAlertCopy({ kind: "cannot_check", provider: "anthropic" }).title).toBe(
      "Moss can't check for tool updates"
    );
    expect(cliToolAlertCopy({ kind: "too_old", provider: "openai-compatible" }).title).toBe(
      "Codex chat needs an update"
    );
  });
});

describe("cliToolAlertKey", () => {
  const alert = { kind: "held_back", provider: "anthropic", version: "2.1.290" } as const;
  it("changes with the day, the version and the kind", () => {
    const day1 = new Date("2026-09-30T01:00:00Z");
    const day2 = new Date("2026-10-01T01:00:00Z");
    expect(cliToolAlertKey(alert, day1)).toBe(
      cliToolAlertKey(alert, new Date("2026-09-30T23:00:00Z"))
    );
    expect(cliToolAlertKey(alert, day1)).not.toBe(cliToolAlertKey(alert, day2));
    expect(cliToolAlertKey(alert, day1)).not.toBe(
      cliToolAlertKey({ ...alert, version: "2.1.291" }, day1)
    );
    expect(cliToolAlertKey(alert, day1)).not.toBe(
      cliToolAlertKey({ ...alert, kind: "too_old" }, day1)
    );
  });
});

describe("buildCliToolAlertRaiser", () => {
  it("runs once per admin, then not again for the same alert the same day", async () => {
    const withDataContext = vi.fn(async () => undefined);
    const raise = buildCliToolAlertRaiser({
      dataContext: { withDataContext } as never,
      listAdminIds: async () => ["admin-1", "admin-2"],
      now: () => new Date("2026-09-30T01:00:00Z")
    });
    const alert = { kind: "held_back", provider: "anthropic", version: "2.1.290" } as const;
    await raise(alert);
    await raise(alert);
    expect(withDataContext).toHaveBeenCalledTimes(2);
    expect(withDataContext.mock.calls.map((call) => (call as unknown[])[0])).toEqual([
      expect.objectContaining({ actorUserId: "admin-1" }),
      expect.objectContaining({ actorUserId: "admin-2" })
    ]);
  });

  it("keeps going when one admin's write fails", async () => {
    const withDataContext = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(undefined);
    const raise = buildCliToolAlertRaiser({
      dataContext: { withDataContext } as never,
      listAdminIds: async () => ["a", "b"]
    });
    await expect(raise({ kind: "cannot_check", provider: "anthropic" })).resolves.toBeUndefined();
    expect(withDataContext).toHaveBeenCalledTimes(2);
  });
});

describe("buildCliVersionTooOldHandler", () => {
  it("raises a too-old alert and starts an update pass right away", () => {
    const raise = vi.fn(async () => undefined);
    const pass = vi.fn(async () => undefined);
    buildCliVersionTooOldHandler({ raiseAlert: raise, pass })();
    expect(raise).toHaveBeenCalledWith({ kind: "too_old", provider: "anthropic" });
    expect(pass).toHaveBeenCalledTimes(1);
  });

  it("does not throw when the alert or the pass fails", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const handler = buildCliVersionTooOldHandler({
      raiseAlert: async () => Promise.reject(new Error("db down")),
      pass: async () => Promise.reject(new Error("runner down"))
    });
    expect(() => handler()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
