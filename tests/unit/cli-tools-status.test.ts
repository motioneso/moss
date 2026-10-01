/**
 * The provider card's update state (#2689 slice 4): derived from stored records, never from
 * model words.
 */
import { describe, expect, it } from "vitest";

import {
  CANNOT_CHECK_AFTER_MS,
  CliToolsStatusStore,
  cliToolReasonText,
  deriveCliToolsDto,
  type CliToolsStatusSnapshot
} from "../../packages/ai/src/cli-tools-status.js";

const quiet: CliToolsStatusSnapshot = {
  checking: new Set(),
  needsNewerMoss: {},
  cannotCheck: false
};
const derive = (
  update: Parameters<typeof deriveCliToolsDto>[0]["update"],
  status: CliToolsStatusSnapshot = quiet,
  version: string | null = "2.1.282"
) => deriveCliToolsDto({ provider: "anthropic", version, update, status });

const failed = {
  candidateVersion: "2.1.290",
  lastCheck: { at: "2026-09-30T01:00:00Z", result: "failed" as const, reason: "tool_call_missing" }
};

describe("deriveCliToolsDto", () => {
  it("is plain when nothing is staged", () => {
    expect(derive(undefined)).toEqual({ version: "2.1.282", state: "current" });
    expect(derive({ candidateVersion: null, lastCheck: null })).toEqual({
      version: "2.1.282",
      state: "current"
    });
  });

  it("says not installed with no version", () => {
    expect(derive(undefined, quiet, null)).toEqual({ version: null, state: "not_installed" });
  });

  it("says checking while a check runs, and for a staged candidate not yet checked", () => {
    const running = { ...quiet, checking: new Set(["anthropic"]) };
    expect(derive({ candidateVersion: "2.1.290", lastCheck: null }, running)).toMatchObject({
      state: "checking",
      candidateVersion: "2.1.290"
    });
    expect(derive({ candidateVersion: "2.1.290", lastCheck: null }).state).toBe("checking");
    expect(derive(failed, running).state).toBe("checking");
  });

  it("holds back a failed candidate with a plain reason from the fixed list", () => {
    expect(derive(failed)).toEqual({
      version: "2.1.282",
      state: "held_back",
      candidateVersion: "2.1.290",
      lastCheckedAt: "2026-09-30T01:00:00Z",
      reason: "couldn't use Moss's tools in a test chat"
    });
  });

  it("never passes a raw reason string through", () => {
    expect(cliToolReasonText("anything <script> else")).toBe("failed its check");
    expect(cliToolReasonText("timeout")).toBe("didn't answer in time");
    expect(cliToolReasonText("structured_call_failed")).toBe(
      "didn't return usable answers to a background request"
    );
    expect(cliToolReasonText("promote_failed")).toBe("couldn't be installed");
  });

  it("says needs a newer Moss, then cannot check, in that order", () => {
    const both = { ...quiet, needsNewerMoss: { anthropic: "2.1.300" }, cannotCheck: true };
    expect(derive(undefined, both)).toMatchObject({
      state: "needs_newer_moss",
      candidateVersion: "2.1.300"
    });
    expect(derive(undefined, { ...quiet, cannotCheck: true }).state).toBe("cannot_check");
  });

  it("puts a held back candidate ahead of a newer-Moss wait", () => {
    const status = { ...quiet, needsNewerMoss: { anthropic: "2.1.300" } };
    expect(derive(failed, status).state).toBe("held_back");
  });
});

describe("CliToolsStatusStore", () => {
  const ok = { status: "ok", staged: [], skipped: {}, failed: [] } as const;
  const down = { status: "fetch-failed", staged: [], skipped: {}, failed: [] } as const;

  it("tracks a running check", () => {
    const store = new CliToolsStatusStore();
    store.setChecking("anthropic", true);
    expect(store.snapshot().checking.has("anthropic")).toBe(true);
    store.setChecking("anthropic", false);
    expect(store.snapshot().checking.has("anthropic")).toBe(false);
  });

  it("holds the newer-Moss wait until a later pass clears it", () => {
    const store = new CliToolsStatusStore();
    store.recordRefresh({ ...ok, needsNewerMoss: { anthropic: "2.1.300" } });
    expect(store.snapshot().needsNewerMoss).toEqual({ anthropic: "2.1.300" });
    store.recordRefresh({ status: "up-to-date", staged: [], skipped: {}, failed: [] });
    expect(store.snapshot().needsNewerMoss).toEqual({ anthropic: "2.1.300" });
    store.recordRefresh(ok);
    expect(store.snapshot().needsNewerMoss).toEqual({});
  });

  it("cannot check only after three days of failed fetches, and recovers on success", () => {
    const store = new CliToolsStatusStore();
    const t0 = 1_000_000;
    store.recordRefresh(down, t0);
    expect(store.snapshot(t0 + CANNOT_CHECK_AFTER_MS - 1).cannotCheck).toBe(false);
    store.recordRefresh(down, t0 + CANNOT_CHECK_AFTER_MS - 1);
    expect(store.snapshot(t0 + CANNOT_CHECK_AFTER_MS).cannotCheck).toBe(true);
    store.recordRefresh(ok, t0 + CANNOT_CHECK_AFTER_MS + 1);
    expect(store.snapshot(t0 + CANNOT_CHECK_AFTER_MS + 2).cannotCheck).toBe(false);
  });

  it("ignores a runner that is down", () => {
    const store = new CliToolsStatusStore();
    store.recordRefresh({ ...down, status: "runner-unavailable" }, 0);
    expect(store.snapshot(CANNOT_CHECK_AFTER_MS * 2).cannotCheck).toBe(false);
  });
});
