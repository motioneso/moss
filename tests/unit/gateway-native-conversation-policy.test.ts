import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type AssistantToolGatewayDependencies,
  type ConversationProvenancePort
} from "@moss/ai";

function build(
  options: {
    yolo?: boolean;
    threadId?: string | null;
    deps?: Partial<AssistantToolGatewayDependencies>;
  } = {}
) {
  const tokens = new SessionTokenRegistry();
  const confirmations = new ConfirmationRegistry();
  const createPending = vi.fn(async () => ({ id: "action-1" }));
  const resolveAction = vi.fn(async () => ({ id: "action-1", status: "confirmed" }));
  const audit = vi.fn(async () => undefined);
  const emit = vi.fn();
  const isTainted = vi.fn(async () => true);
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [],
    tokens,
    confirmations,
    repository: {
      createPendingAssistantAction: createPending,
      resolveAssistantAction: resolveAction,
      insertActionAuditLog: audit
    } as never,
    runner: {
      withDataContext: async (_access: unknown, work: (db: unknown) => unknown) => work({})
    } as never,
    notifier: { emit },
    confirmTimeoutMs: 500,
    provenance: { isTainted, recordAdmission: vi.fn() },
    yoloMode: async () => options.yolo ?? true,
    ...options.deps
  });
  const token = tokens.mint({
    actorUserId: "actor-a",
    chatSessionId: "actor-a:chat",
    threadId: options.threadId === undefined ? "thread-a" : options.threadId,
    allowedToolNames: null
  });
  return { gateway, token, createPending, resolveAction, audit, emit, confirmations, isTainted };
}

const request = {
  cwd: "/workspace/project",
  home: "/home/agent",
  sessionId: "agent-session",
  turnId: "turn-1",
  toolCallId: "call-1",
  title: "Use tool",
  toolName: "Bash",
  toolInput: { command: "echo hello" }
};
const mutations = [
  { toolName: "Read", toolInput: { file_path: "/etc/hosts" } },
  { toolName: "Write", toolInput: { file_path: "/workspace/project/file.txt" } },
  { toolName: "WebSearch", toolInput: { query: "public topic" } },
  { toolName: "WebFetch", toolInput: { url: "https://example.com" } },
  { toolName: "Bash", toolInput: { command: "echo hello" } }
];
const unavailable: Array<
  [string, { threadId?: string | null; deps?: Partial<AssistantToolGatewayDependencies> }]
> = [
  ["missing thread", { threadId: null }],
  ["missing port", { deps: { provenance: undefined } }],
  [
    "storage failure",
    {
      deps: {
        provenance: {
          isTainted: async () => {
            throw new Error("private storage detail");
          },
          recordAdmission: vi.fn()
        }
      }
    }
  ]
];

async function reject(h: ReturnType<typeof build>, pending: Promise<unknown>) {
  await vi.waitFor(
    () =>
      expect(h.emit).toHaveBeenCalledWith(
        "actor-a:chat",
        expect.objectContaining({ kind: "action_request" })
      ),
    { interval: 1 }
  );
  h.confirmations.resolve("action-1", "rejected");
  expect(await pending).toMatchObject({ decision: "deny" });
  expect(h.resolveAction).not.toHaveBeenCalled();
}

describe("outside-agent conversation taint", () => {
  it.each([false, true])(
    "requires a card for writes, web, shell and already-gated reads while tainted (YOLO=%s)",
    async (yolo) => {
      for (const mutation of mutations) {
        const h = build({ yolo });
        await reject(
          h,
          h.gateway.requestAcpBuiltInPermission(h.token, { ...request, ...mutation })
        );
        expect(h.isTainted).toHaveBeenCalledWith("actor-a", "thread-a");
        expect(h.audit).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ approvalMode: "yolo" })
        );
      }
    }
  );

  it.each(unavailable)("requires a card when %s", async (_label, options) => {
    for (const mutation of mutations) {
      const h = build(options);
      await reject(h, h.gateway.requestAcpBuiltInPermission(h.token, { ...request, ...mutation }));
      expect(JSON.stringify(h.emit.mock.calls)).not.toContain("private storage detail");
    }
  });

  it.each(["Read", "mcp__moss__settings_change", "TodoWrite"])(
    "preserves the safe %s allowance while tainted",
    async (toolName) => {
      const h = build();
      expect(
        await h.gateway.requestAcpBuiltInPermission(h.token, {
          ...request,
          toolName,
          toolInput: { file_path: "/workspace/project/file.txt" }
        })
      ).toMatchObject({ decision: "allow", asked: false });
      expect(h.createPending).not.toHaveBeenCalled();
    }
  );

  it("retains hard denials without offering approval", async () => {
    const h = build();
    expect(
      await h.gateway.requestAcpBuiltInPermission(h.token, {
        ...request,
        toolName: "Read",
        toolInput: { file_path: "/proc/self/environ" }
      })
    ).toMatchObject({ decision: "deny", asked: false });
    expect(h.createPending).not.toHaveBeenCalled();
  });

  it("rechecks taint after an asynchronous YOLO lookup", async () => {
    let tainted = false;
    const provenance: ConversationProvenancePort = {
      isTainted: async () => tainted,
      recordAdmission: vi.fn()
    };
    const h = build({
      deps: {
        provenance,
        yoloMode: async () => {
          tainted = true;
          return true;
        }
      }
    });
    await reject(h, h.gateway.requestAcpBuiltInPermission(h.token, request));
  });
});

describe("native conversation taint", () => {
  it.each(unavailable)(
    "requires a card for an otherwise YOLO-eligible write with %s",
    async (_label, options) => {
      const cwd = await mkdtemp(join(tmpdir(), "moss-taint-native-"));
      try {
        const h = build(options);
        await reject(
          h,
          h.gateway.requestNativeToolPermission(h.token, {
            toolName: "Write",
            toolInput: { file_path: join(cwd, "file.txt") },
            workingDirectory: cwd
          })
        );
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  );

  it.each(["Edit", "Write", "NotebookEdit"])(
    "taint blocks the clean-thread YOLO allowance for %s",
    async (toolName) => {
      const cwd = await mkdtemp(join(tmpdir(), "moss-taint-native-"));
      try {
        const permission = {
          toolName,
          toolInput: {
            [toolName === "NotebookEdit" ? "notebook_path" : "file_path"]: join(cwd, "file.txt")
          },
          workingDirectory: cwd
        };
        const h = build();
        await reject(h, h.gateway.requestNativeToolPermission(h.token, permission));
        h.isTainted.mockResolvedValue(false);
        expect(await h.gateway.requestNativeToolPermission(h.token, permission)).toMatchObject({
          decision: "allow",
          reason: "Allowed by YOLO."
        });
        expect(h.resolveAction).toHaveBeenCalledOnce();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  );

  it.each(["ToolSearch", "mcp__jarvis__settings__change"])(
    "keeps %s on its existing downstream read/gateway path",
    async (toolName) => {
      const h = build();
      expect(
        await h.gateway.requestNativeToolPermission(h.token, { toolName, toolInput: {} })
      ).toMatchObject({ decision: "allow" });
      expect(h.createPending).not.toHaveBeenCalled();
    }
  );

  it("rechecks taint after an asynchronous YOLO lookup", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "moss-taint-native-"));
    try {
      let tainted = false;
      const h = build({
        deps: {
          provenance: { isTainted: async () => tainted, recordAdmission: vi.fn() },
          yoloMode: async () => {
            tainted = true;
            return true;
          }
        }
      });
      await reject(
        h,
        h.gateway.requestNativeToolPermission(h.token, {
          toolName: "Write",
          toolInput: { file_path: join(cwd, "file.txt") },
          workingDirectory: cwd
        })
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
