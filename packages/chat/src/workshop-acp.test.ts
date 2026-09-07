import { describe, expect, it, vi, beforeEach } from "vitest";

import {
  RpcAcpTunnel,
  chatSessionAllowlist,
  createWorkshopAcpOpener,
  createWorkshopRunCommandService
} from "./workshop-acp.js";
import { WORKSHOP_AGENT_TOOL_NAMES } from "@moss/workshop";

describe("RpcAcpTunnel", () => {
  it("maps each tunnel method to its runner verb with the session key", async () => {
    const seen: { verb: string; sessionKey: string }[] = [];
    const spy = (verb: string, result: unknown) => async (sessionKey: string) => {
      seen.push({ verb, sessionKey });
      return result;
    };
    const stub = {
      acpSpawn: spy("acpSpawn", { cwd: "/r/s", home: null, generation: 1 }),
      acpSend: spy("acpSend", { accepted: true }),
      acpRead: spy("acpRead", {
        lines: ["a"],
        firstSeq: 1,
        nextSeq: 1,
        exited: false,
        exitCode: null,
        truncated: false
      }),
      acpKill: spy("acpKill", { ok: true }),
      acpExecStart: spy("acpExecStart", { execId: 7 }),
      acpExecPoll: spy("acpExecPoll", {
        output: "out",
        done: true,
        exitCode: 0,
        truncated: false,
        timedOut: false
      }),
      acpExecKill: spy("acpExecKill", { ok: true })
    };
    const tunnel = new RpcAcpTunnel(stub as never);

    await expect(tunnel.spawn("k", "p")).resolves.toEqual({ cwd: "/r/s", home: null });
    await tunnel.send("k", "line");
    await expect(tunnel.read("k", 0)).resolves.toMatchObject({ lines: ["a"] });
    await tunnel.kill("k");
    await expect(tunnel.execStart("k", "p", "echo hi", 1000)).resolves.toEqual({ execId: 7 });
    await expect(tunnel.execPoll("k", 7)).resolves.toMatchObject({ output: "out", done: true });
    await tunnel.execKill("k", 7);

    expect(seen.map((call) => call.verb)).toEqual([
      "acpSpawn",
      "acpSend",
      "acpRead",
      "acpKill",
      "acpExecStart",
      "acpExecPoll",
      "acpExecKill"
    ]);
    expect(seen.every((call) => call.sessionKey === "k")).toBe(true);
  });

  it("passes the project, command, and deadline through to execStart", async () => {
    const seen: { sessionKey: string; params: unknown }[] = [];
    const stub = {
      acpExecStart: async (sessionKey: string, params: unknown) => {
        seen.push({ sessionKey, params });
        return { execId: 1 };
      }
    };
    const tunnel = new RpcAcpTunnel(stub as never);
    await tunnel.execStart("workshop:u:p", "p", "pnpm build", 60_000);
    expect(seen).toEqual([
      {
        sessionKey: "workshop:u:p",
        params: { projectId: "p", command: "pnpm build", timeoutMs: 60_000 }
      }
    ]);
  });
});

describe("createWorkshopRunCommandService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("starts, polls, and kills over the exec verbs", async () => {
    const stub = {
      acpExecStart: vi.fn(async () => ({ execId: 3 })),
      acpExecPoll: vi.fn(async () => ({
        output: "done",
        done: true,
        exitCode: 0,
        truncated: false,
        timedOut: false
      })),
      acpExecKill: vi.fn(async () => ({ ok: true }))
    };
    const service = createWorkshopRunCommandService(() => stub as never);
    await expect(
      service.start({ sessionKey: "k", projectId: "p", command: "c", timeoutMs: 1000 })
    ).resolves.toEqual({ execId: 3 });
    await expect(service.poll({ sessionKey: "k", execId: 3 })).resolves.toMatchObject({
      output: "done",
      done: true
    });
    await service.kill({ sessionKey: "k", execId: 3 });
    expect(stub.acpExecKill).toHaveBeenCalledWith("k", { execId: 3 });
  });

  it("fails closed without a runner connection", async () => {
    const service = createWorkshopRunCommandService(() => undefined);
    await expect(
      service.start({ sessionKey: "k", projectId: "p", command: "c", timeoutMs: 1000 })
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("workshop agent tool set", () => {
  it("is exactly the build command, a subset of the manifest tools", async () => {
    const { workshopModuleManifest } = await import("@moss/workshop");
    const manifestNames = new Set(
      (workshopModuleManifest.assistantTools ?? []).map((tool) => tool.name)
    );
    expect([...WORKSHOP_AGENT_TOOL_NAMES]).toEqual(["workshop.runCommand"]);
    for (const name of WORKSHOP_AGENT_TOOL_NAMES) {
      expect(manifestNames.has(name)).toBe(true);
    }
  });

  it("stays out of chat session allowlists, handover tool included", () => {
    const allowed = chatSessionAllowlist([
      "workshop.runCommand",
      "workshop.buildModule",
      "chat.summarize"
    ]);
    expect(allowed.has("workshop.runCommand")).toBe(false);
    expect(allowed.has("workshop.buildModule")).toBe(true);
    expect(allowed.has("chat.summarize")).toBe(true);
  });
});

describe("createWorkshopAcpOpener", () => {
  it("says plainly when the runner connection is not up", async () => {
    const opener = createWorkshopAcpOpener({
      getConnection: () => undefined,
      tokens: {} as never,
      mcpServerUrl: "http://moss.local/api/mcp",
      permissionGateway: {} as never
    });
    await expect(
      opener.open({ sessionKey: "k", projectId: "p", actorUserId: "u" })
    ).rejects.toThrow(/runner connection/);
  });

  it("revokes the minted Bearer [REDACTED] the session open fails", async () => {
    const mint = vi.fn(() => "jst_test");
    const revokeBySessionId = vi.fn();
    const opener = createWorkshopAcpOpener({
      getConnection: () =>
        ({
          acpSpawn: async () => {
            throw new Error("runner down");
          }
        }) as never,
      tokens: { mint, revokeBySessionId } as never,
      mcpServerUrl: "http://moss.local/api/mcp",
      permissionGateway: {} as never
    });
    await expect(
      opener.open({ sessionKey: "workshop:u:p", projectId: "p", actorUserId: "u" })
    ).rejects.toThrow(/runner down/);
    expect(mint).toHaveBeenCalledTimes(1);
    const minted = mint.mock.calls.at(0)?.at(0) as
      | { chatSessionId?: string; allowedToolNames?: Set<string> }
      | undefined;
    expect(minted?.chatSessionId).toBe("workshop:u:p");
    expect(minted?.allowedToolNames).toEqual(new Set(["workshop.runCommand"]));
    expect(revokeBySessionId).toHaveBeenCalledWith("workshop:u:p");
  });
});
