import { describe, expect, it, vi } from "vitest";

import { AssistantToolGateway } from "@moss/ai";
import {
  WORKSHOP_RUN_COMMAND_SERVICE_KEY,
  workshopModuleManifest,
  workshopRunCommandExecute,
  type WorkshopRunCommandService,
  type WorkshopRunCommandState
} from "@moss/workshop";

const SESSION = "workshop:user-a:proj";

const ctx = {
  actorUserId: "user-a",
  requestId: "req-1",
  chatSessionId: SESSION
};

/** A stub runner service scripted with one poll response per call. */
function scriptedService(states: WorkshopRunCommandState[]) {
  const calls = { starts: [] as unknown[], polls: 0, kills: 0 };
  const queue = [...states];
  const service: WorkshopRunCommandService = {
    start: async (input) => {
      calls.starts.push(input);
      return { execId: 7 };
    },
    poll: async () => {
      calls.polls += 1;
      return queue.length > 0 ? (queue.shift() as WorkshopRunCommandState) : (queue[0] as never);
    },
    kill: async () => {
      calls.kills += 1;
    }
  };
  return { service, calls };
}

const doneState = (output: string): WorkshopRunCommandState => ({
  output,
  done: true,
  exitCode: 0,
  truncated: false,
  timedOut: false
});

function findTool() {
  const tool = workshopModuleManifest.assistantTools?.find(
    (entry) => entry.name === "workshop.runCommand"
  );
  if (!tool) throw new Error("workshop.runCommand is missing from the manifest");
  return tool;
}

describe("workshop.runCommand manifest declaration", () => {
  it("is a write tool in the workshop_builds family with runner-service access", () => {
    const tool = findTool();
    // risk "write" is load-bearing: the gateway only emits an action_result record for
    // non-read tools, so a read tool's build log would never reach the browser at all.
    expect(tool.risk).toBe("write");
    expect(tool.actionFamilyId).toBe("workshop_builds");
    expect(tool.executionPolicy).toBe("auto");
    expect(tool.selfOperationGrant).toBe("user_promotable");
    expect(tool.requiresServices).toEqual([WORKSHOP_RUN_COMMAND_SERVICE_KEY]);
    // Ordinary text output: the rendered log is what the model and browser see.
    expect(tool.streamsStructuredResult).not.toBe(true);
  });

  it("declares a family that starts at ask each time but can run unattended", () => {
    const family = workshopModuleManifest.assistantActionFamilies?.find(
      (entry) => entry.id === "workshop_builds"
    );
    expect(family?.defaultTier).toBe("ask_each_time");
    expect(family?.allowedTiers).toEqual(["ask_each_time", "trusted_auto", "always_confirm"]);
  });

  it("takes a command and an optional deadline, never a folder", () => {
    const properties = Object.keys(findTool().inputSchema?.properties ?? {});
    expect(properties.sort()).toEqual(["command", "timeoutMs"]);
  });

  it("puts the actual command on the approval card", () => {
    const tool = findTool();
    const summary = tool.summarize?.(
      { command: "pnpm build" },
      {
        actorUserId: "user-a",
        requestId: "req-1",
        chatSessionId: "workshop:user-a:proj"
      }
    );
    expect(summary).toContain("pnpm build");
  });
});

describe("workshop.runCommand execute", () => {
  it("runs in the session project and returns the finished output", async () => {
    const { service, calls } = scriptedService([
      { ...doneState(""), done: false, exitCode: null },
      doneState("building\nbuilt ok\n")
    ]);
    const result = await workshopRunCommandExecute({}, { command: "pnpm build" }, ctx, {
      workshopRunCommand: service
    });
    expect(result.data).toEqual({
      output: "building\nbuilt ok\n",
      exitCode: 0,
      truncated: false,
      timedOut: false
    });
    // The folder is derived from the session, never taken from the input.
    expect(calls.starts).toEqual([
      { sessionKey: SESSION, projectId: "proj", command: "pnpm build", timeoutMs: 300_000 }
    ]);
  });

  it("streams fresh output as progress while the build runs", async () => {
    const messages: string[] = [];
    const { service } = scriptedService([
      { ...doneState("half\n"), done: false, exitCode: null },
      doneState("half\nwhole\n")
    ]);
    await workshopRunCommandExecute(
      {},
      { command: "pnpm build" },
      {
        ...ctx,
        reportProgress: (message) => messages.push(message)
      },
      { workshopRunCommand: service }
    );
    expect(messages).toEqual(["half\n", "whole\n"]);
  });

  it("says plainly when output was cut or the deadline stopped the command", async () => {
    const cut = scriptedService([
      { output: "kept head", done: true, exitCode: 0, truncated: true, timedOut: false }
    ]);
    const cutResult = await workshopRunCommandExecute({}, { command: "yes" }, ctx, {
      workshopRunCommand: cut.service
    });
    expect(cutResult.data.truncated).toBe(true);
    expect(cutResult.data.output).toContain("cut at 256 KiB");

    const slow = scriptedService([
      { output: "partial log", done: true, exitCode: null, truncated: false, timedOut: true }
    ]);
    const slowResult = await workshopRunCommandExecute({}, { command: "sleep 999" }, ctx, {
      workshopRunCommand: slow.service
    });
    expect(slowResult.data).toMatchObject({
      output: expect.stringContaining("partial log"),
      timedOut: true
    });
    expect(slowResult.data.output).toContain("stopped after the timeout");
  });

  it("stops waiting on a silent runner and returns what ran so far", async () => {
    const { service, calls } = scriptedService([]);
    (service as { poll?: unknown }).poll = async () => {
      calls.polls += 1;
      return {
        output: "stuck log",
        done: false,
        exitCode: null,
        truncated: false,
        timedOut: false
      };
    };
    const result = await workshopRunCommandExecute(
      {},
      { command: "sleep 999", timeoutMs: 1000 },
      ctx,
      {
        workshopRunCommand: service
      }
    );
    expect(result.data).toMatchObject({
      output: expect.stringContaining("stuck log"),
      timedOut: true
    });
    expect(calls.kills).toBe(1);
  }, 15000);

  it.each(["", "   ", "x\0", "x".repeat(32769)])(
    "rejects an invalid command %j",
    async (command) => {
      const { service, calls } = scriptedService([doneState("")]);
      await expect(
        workshopRunCommandExecute({}, { command }, ctx, { workshopRunCommand: service })
      ).rejects.toThrow(/command/i);
      expect(calls.starts).toHaveLength(0);
    }
  );

  it.each([0, 999, 601_000, "soon", 1.5])("rejects an invalid deadline %j", async (timeoutMs) => {
    const { service, calls } = scriptedService([doneState("")]);
    await expect(
      workshopRunCommandExecute({}, { command: "pnpm build", timeoutMs }, ctx, {
        workshopRunCommand: service
      })
    ).rejects.toThrow(/timeoutMs/i);
    expect(calls.starts).toHaveLength(0);
  });

  it.each(["chat-1", "workshop:proj", "other:user-a:proj", "workshop:user-a:../x"])(
    "runs only in a Workshop project session, not %s",
    async (chatSessionId) => {
      const { service, calls } = scriptedService([doneState("")]);
      await expect(
        workshopRunCommandExecute(
          {},
          { command: "pnpm build" },
          { ...ctx, chatSessionId },
          {
            workshopRunCommand: service
          }
        )
      ).rejects.toThrow(/Workshop project session/);
      expect(calls.starts).toHaveLength(0);
    }
  );

  it("fails closed when the host wired no runner service", async () => {
    await expect(workshopRunCommandExecute({}, { command: "pnpm build" }, ctx, {})).rejects.toThrow(
      /not available/i
    );
  });
});

describe("workshop.runCommand session allowlist", () => {
  function makeDeps(toolServices: Record<string, unknown>) {
    return {
      resolveActiveModules: vi.fn().mockResolvedValue([workshopModuleManifest]),
      repository: {
        resolveAssistantAction: vi.fn(),
        createPendingAssistantAction: vi.fn()
      } as never,
      runner: {
        rootDb: {} as never,
        withDataContext: vi.fn(async (_ctx: unknown, fn: (db: never) => unknown) => fn({} as never))
      } as never,
      tokens: { verify: vi.fn(), mint: vi.fn() } as never,
      confirmations: {
        awaitResolution: vi.fn(),
        isAwaiting: vi.fn(),
        resolve: vi.fn()
      } as never,
      notifier: { emit: vi.fn() } as never,
      confirmTimeoutMs: 5000,
      toolServices
    };
  }

  it("appears in the executable set once the runner service is wired", async () => {
    const gw = new AssistantToolGateway(makeDeps({ workshopRunCommand: {} }));
    const names = (await gw.listToolsForActor("user-a")).map((tool) => tool.name);
    expect(names).toContain("workshop.runCommand");
  });

  it("stays hidden without the runner service, so no token can allow it", async () => {
    const gw = new AssistantToolGateway(makeDeps({}));
    const names = (await gw.listToolsForActor("user-a")).map((tool) => tool.name);
    expect(names).not.toContain("workshop.runCommand");
  });

  it("refuses a session token whose allowlist does not name it", async () => {
    const deps = makeDeps({ workshopRunCommand: {} });
    (deps.tokens as { verify: unknown }).verify = vi.fn().mockReturnValue({
      actorUserId: "user-a",
      chatSessionId: SESSION,
      allowedToolNames: new Set(["workshop.buildModule"])
    });
    const gw = new AssistantToolGateway(deps);
    const result = await gw.callTool("tok", "workshop.runCommand", { command: "pnpm build" });
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).toMatch(/allowlist/);
    } else {
      throw new Error("expected an allowlist refusal");
    }
  });
});
