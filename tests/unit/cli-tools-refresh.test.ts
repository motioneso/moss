import { describe, expect, it, vi } from "vitest";

import {
  runCliToolsRefresh,
  type CliToolsRefreshPorts,
  type RefreshManifest
} from "../../packages/ai/src/cli-tools-refresh.js";

const cmp = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

function manifest(over: Partial<RefreshManifest["toolsets"]["anthropic"]> = {}): RefreshManifest {
  return {
    sequence: 7,
    toolsets: {
      anthropic: {
        minMossVersion: "0.1.0",
        packages: [{ role: "cli", pkg: "@a/cli", version: "2.0.0", lockfile: "a.json" }],
        ...over
      }
    }
  };
}

function ports(over: Partial<CliToolsRefreshPorts> = {}) {
  const stage = vi.fn<CliToolsRefreshPorts["stage"]>(async () => ({ state: "staged" }));
  const p: CliToolsRefreshPorts = {
    getState: async () => ({ manifestSequence: 5, candidates: {} }),
    listVersions: async () => ({
      providers: { anthropic: "1.0.0", "openai-compatible": null, google: null },
      opencode: null
    }),
    fetchManifest: async () => ({
      ok: true,
      manifest: manifest(),
      lockfiles: { "a.json": new TextEncoder().encode("{}") }
    }),
    stage,
    compareVersions: cmp,
    mossVersion: () => "0.2.0",
    ...over
  };
  return { p, stage };
}

describe("runCliToolsRefresh", () => {
  it("stages a newer toolset with the old sequence, then records the new one", async () => {
    const { p, stage } = ports();
    const out = await runCliToolsRefresh(p);
    expect(out).toMatchObject({ status: "ok", staged: ["anthropic"], failed: [] });
    expect(stage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: "anthropic", manifestSequence: 5 })
    );
    expect(stage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ manifestSequence: 7, packages: [] })
    );
  });

  it("passes the lockfile text the fetcher already verified", async () => {
    const { p, stage } = ports();
    await runCliToolsRefresh(p);
    const first = stage.mock.calls[0]![0];
    expect(first.packages[0]).toMatchObject({ pkg: "@a/cli", lockfileText: "{}" });
  });

  it("skips a toolset that is not newer than the live one", async () => {
    const { p, stage } = ports({
      listVersions: async () => ({
        providers: { anthropic: "2.0.0", "openai-compatible": null, google: null },
        opencode: null
      })
    });
    const out = await runCliToolsRefresh(p);
    expect(out.skipped).toEqual({ anthropic: "not-newer" });
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage.mock.calls[0]![0].packages).toEqual([]);
  });

  it("skips a toolset that needs a newer Moss, and one when the Moss version is unknown", async () => {
    for (const moss of ["0.0.9", undefined]) {
      const { p, stage } = ports({ mossVersion: () => moss });
      const out = await runCliToolsRefresh(p);
      expect(out.skipped).toEqual({ anthropic: "needs-newer-moss" });
      expect(stage.mock.calls.every((c) => c[0].packages.length === 0)).toBe(true);
    }
  });

  it("does not restage a candidate that is already staged", async () => {
    const { p, stage } = ports({
      getState: async () => ({
        manifestSequence: 5,
        candidates: { anthropic: [{ pkg: "@a/cli", version: "2.0.0" }] }
      })
    });
    const out = await runCliToolsRefresh(p);
    expect(out.skipped).toEqual({ anthropic: "already-staged" });
    expect(stage.mock.calls.every((c) => c[0].packages.length === 0)).toBe(true);
  });

  it("does not record the new sequence when a stage fails, so the next pass retries", async () => {
    const stage = vi.fn<CliToolsRefreshPorts["stage"]>(async () => ({
      state: "error",
      message: "boom"
    }));
    const { p } = ports({ stage });
    const out = await runCliToolsRefresh(p);
    expect(out.failed).toEqual(["anthropic"]);
    expect(stage).toHaveBeenCalledTimes(1);
  });

  it("changes nothing when the fetch fails or the sequence is not newer", async () => {
    for (const [reason, status] of [
      ["signature-mismatch", "fetch-failed"],
      ["sequence-not-newer", "up-to-date"]
    ] as const) {
      const { p, stage } = ports({ fetchManifest: async () => ({ ok: false, reason }) });
      const out = await runCliToolsRefresh(p);
      expect(out.status).toBe(status);
      expect(stage).not.toHaveBeenCalled();
    }
  });

  it("asks the fetcher for a manifest newer than the runner's recorded sequence", async () => {
    const fetchManifest = vi.fn(async () => ({ ok: false as const, reason: "fetch-failed" }));
    await runCliToolsRefresh(ports({ fetchManifest }).p);
    expect(fetchManifest).toHaveBeenCalledWith(5);
  });

  it("does nothing when the runner is unreachable", async () => {
    const { p, stage } = ports({ getState: async () => null });
    expect((await runCliToolsRefresh(p)).status).toBe("runner-unavailable");
    expect(stage).not.toHaveBeenCalled();
  });
});
