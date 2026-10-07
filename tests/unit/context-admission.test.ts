import { describe, expect, it, vi } from "vitest";

import type { AdmissionPath, ConversationProvenancePort } from "@moss/ai";
import {
  admitToContext,
  submitAdmittedContext
} from "../../packages/chat/src/live/context-admission.js";
import { buildEngineText } from "../../packages/chat/src/live/engine-text.js";
import {
  ChatSessionManager,
  type ChatSessionManagerDeps
} from "../../packages/chat/src/live/chat-session-manager.js";
import type { CliChatEngine } from "../../packages/chat/src/live/types.js";
import {
  DEFAULT_CHAT_SURFACE,
  surfaceSessionKey
} from "../../packages/chat/src/live/chat-surface.js";
import { AcpChatEngine } from "../../packages/chat/src/live/acp-chat-engine.js";
import { NotesContextRetriever } from "../../packages/chat/src/live/notes-retrieval.js";

const ACTOR = "actor-a";
const binding = { threadId: "thread-a", chatSessionId: surfaceSessionKey(ACTOR) };

function fixture(overrides: Partial<ChatSessionManagerDeps> = {}) {
  let current = "thread-a";
  const tainted = new Set<string>();
  const provenance: ConversationProvenancePort = {
    isTainted: async (_actor, thread) => !thread || tainted.has(thread),
    recordAdmission: vi.fn(async (_actor, thread) => {
      tainted.add(thread);
    })
  };
  const engine = {
    provider: "anthropic" as const,
    launch: vi.fn(async () => ({ offset: 0 })),
    submit: vi.fn(async () => undefined),
    readNew: vi.fn(async () => ({ records: [], offset: 1, complete: true })),
    isAlive: vi.fn(async () => true),
    kill: vi.fn(async () => undefined),
    interrupt: vi.fn(async () => undefined)
  } satisfies CliChatEngine;
  const deps: ChatSessionManagerDeps = {
    engineFactory: () => engine,
    persistence: {
      resolveActiveProvider: async () => ({ provider: "anthropic", model: "default" }),
      getCurrentThreadState: async () => ({ id: current, incognito: false }),
      listPriorTurns: vi.fn(async () => ({ recent: [], oldSummary: null })),
      getThreadContext: vi.fn(async () => ({
        threadTitle: null,
        localTimezone: "UTC",
        incognito: false
      })),
      openNewConversation: async () => {
        current = "thread-b";
      },
      touchExistingThread: async (_actor, thread) => {
        current = thread;
        return true;
      },
      recordTurn: vi.fn(async () => undefined)
    },
    conversationProvenance: provenance,
    personaFs: { mkdir: vi.fn(async () => undefined), writeFile: vi.fn(async () => undefined) },
    persona: "Trusted persona",
    clock: { now: () => 1 },
    idleMs: 1000,
    neutralBase: "/tmp/admission-test",
    pollMs: 0,
    ...overrides
  };
  return {
    deps,
    engine,
    provenance,
    tainted,
    manager: new ChatSessionManager(deps),
    select: (id: string) => {
      current = id;
    }
  };
}

describe("typed context admission", () => {
  it.each(["", " ", "\n\t"])(
    "does not record an empty block %j, even without binding",
    async (text) => {
      const recordForThread = vi.fn();
      expect(await admitToContext({ recordForThread }, null, "recall_notes", text)).toBeNull();
      expect(recordForThread).not.toHaveBeenCalled();
    }
  );

  it("waits for a successful record before exposing or submitting text", async () => {
    let release!: () => void;
    const recordForThread = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const submit = vi.fn(async () => undefined);
    let exposed = false;
    const pending = admitToContext(
      { recordForThread },
      "thread-a",
      "recall_notes",
      "outside marker"
    ).then(async (block) => {
      exposed = true;
      if (block) await submitAdmittedContext({ submit }, block);
    });
    await Promise.resolve();
    expect(exposed).toBe(false);
    expect(submit).not.toHaveBeenCalled();
    release();
    await pending;
    expect(recordForThread).toHaveBeenCalledExactlyOnceWith("thread-a", "recall_notes");
    expect(submit).toHaveBeenCalledExactlyOnceWith("outside marker");
  });

  it("refuses missing binding and recording failure before any exposure", async () => {
    const recordForThread = vi.fn(async () => {
      throw new Error("storage unavailable");
    });
    await expect(
      admitToContext({ recordForThread }, null, "recall_notes", "outside marker")
    ).rejects.toThrow("binding");
    expect(recordForThread).not.toHaveBeenCalled();
    await expect(
      admitToContext({ recordForThread }, "thread-a", "recall_notes", "outside marker")
    ).rejects.toThrow("provenance could not be recorded");
  });
});

describe("non-tool prompt sources", () => {
  it.each([
    ["passive memory", "recall_memory_turn"],
    ["automatic notes", "recall_notes"],
    ["cross-tool", "recall_cross_tool"]
  ] as const)(
    "records %s on the captured thread before returning model text",
    async (source, path) => {
      const f = fixture();
      const runReadTool = vi.fn(async () => ({
        ok: true,
        data: { items: [{ title: "Outside task marker" }] }
      }));
      const result = await buildEngineText(
        {
          persistence: f.deps.persistence,
          conversationProvenance: f.provenance,
          ...(source === "passive memory"
            ? { passiveRetrieval: { retrieve: async () => "Outside memory marker" } }
            : {}),
          ...(source === "automatic notes"
            ? {
                notesRetrieval: {
                  retrieveWithItems: async () => ({ block: "Outside note marker", items: [] })
                }
              }
            : {}),
          ...(source === "cross-tool" ? { crossToolRead: { runReadTool } } : {})
        },
        ACTOR,
        "what should I focus on today?",
        DEFAULT_CHAT_SURFACE,
        binding
      );
      expect(result.text).toContain("Outside");
      expect(f.provenance.recordAdmission).toHaveBeenCalledExactlyOnceWith(ACTOR, "thread-a", path);
      expect(await f.provenance.isTainted(ACTOR, "thread-a")).toBe(true);
      expect(f.deps.persistence.listPriorTurns).toHaveBeenCalledWith(
        ACTOR,
        { threadId: "thread-a" },
        DEFAULT_CHAT_SURFACE
      );
      expect(f.deps.persistence.getThreadContext).toHaveBeenCalledWith(
        ACTOR,
        DEFAULT_CHAT_SURFACE,
        "thread-a"
      );
      if (source === "cross-tool") {
        expect(runReadTool).toHaveBeenCalledWith(
          ACTOR,
          expect.any(String),
          expect.any(Object),
          binding
        );
      }
    }
  );

  it("runs the real automatic notes retriever without a notes tool call and records its admission", async () => {
    const f = fixture();
    const notesRecall = {
      recall: vi.fn(async () => ({
        snippets: [
          {
            sourcePath: "note.md",
            updatedAt: new Date("2026-10-01"),
            score: 1,
            text: "Known project marker"
          }
        ]
      }))
    };
    const notesRetrieval = new NotesContextRetriever({
      dataContext: { withDataContext: async (_access, work) => work({} as never) },
      notesRecall,
      settingsRepo: {
        getOrCreate: async () => ({
          userId: ACTOR,
          recallEnabled: true,
          factsEnabled: true,
          createdAt: new Date(),
          updatedAt: new Date()
        })
      }
    });
    const runReadTool = vi.fn(async () => ({ ok: true, data: {} }));
    const result = await buildEngineText(
      {
        persistence: f.deps.persistence,
        conversationProvenance: f.provenance,
        notesRetrieval,
        crossToolRead: { runReadTool }
      },
      ACTOR,
      "what did we decide about Project?",
      DEFAULT_CHAT_SURFACE,
      binding
    );
    expect(result.text).toContain("Known project marker");
    expect(f.provenance.recordAdmission).toHaveBeenCalledWith(ACTOR, "thread-a", "recall_notes");
    expect(runReadTool.mock.calls).not.toContainEqual(expect.arrayContaining(["notes.search"]));
  });

  it("keeps all-empty recall, notes and cross-tool results clean", async () => {
    const f = fixture();
    const result = await buildEngineText(
      {
        persistence: f.deps.persistence,
        conversationProvenance: f.provenance,
        passiveRetrieval: { retrieve: async () => " \n" },
        notesRetrieval: { retrieveWithItems: async () => ({ block: "\t", items: [] }) },
        crossToolRead: { runReadTool: async () => ({ ok: true, data: {} }) }
      },
      ACTOR,
      "what should I focus on today?",
      DEFAULT_CHAT_SURFACE,
      binding
    );
    expect(result.text).toContain("what should I focus on today?");
    expect(f.provenance.recordAdmission).not.toHaveBeenCalled();
    expect(await f.provenance.isTainted(ACTOR, "thread-a")).toBe(false);
  });

  it("snapshots binding before recall waits, keeping a newly selected thread clean", async () => {
    const f = fixture();
    let release!: (text: string) => void;
    const started = vi.fn();
    const mutableBinding = { ...binding };
    const pending = buildEngineText(
      {
        persistence: f.deps.persistence,
        conversationProvenance: f.provenance,
        passiveRetrieval: {
          retrieve: () => {
            started();
            return new Promise<string>((resolve) => {
              release = resolve;
            });
          }
        }
      },
      ACTOR,
      "recall this",
      DEFAULT_CHAT_SURFACE,
      mutableBinding
    );
    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    mutableBinding.threadId = "thread-b";
    f.select("thread-b");
    release("Outside marker");
    await pending;
    expect(await f.provenance.isTainted(ACTOR, "thread-a")).toBe(true);
    expect(await f.provenance.isTainted(ACTOR, "thread-b")).toBe(false);
  });

  it("does not swallow a failed per-turn admission or submit its outside block", async () => {
    const f = fixture({
      conversationProvenance: {
        recordAdmission: async () => {
          throw new Error("record failed");
        }
      },
      passiveRetrieval: { retrieve: async () => "unrecorded marker" }
    });
    await expect(f.manager.submitTurn(ACTOR, "User", "hello")).rejects.toThrow(
      "provenance could not be recorded"
    );
    expect(f.engine.submit).not.toHaveBeenCalled();
  });

  it("records launch memory before engine launch, without tainting replay a second time", async () => {
    const f = fixture({
      recall: {
        recall: async () => ({
          episodicChunks: [],
          facts: [{ category: "project", content: "Launch marker" }]
        })
      }
    });
    f.engine.launch.mockImplementation(async () => {
      expect(f.provenance.recordAdmission).toHaveBeenCalledWith(
        ACTOR,
        "thread-a",
        "launch_memory_seed"
      );
      return { offset: 0 };
    });
    await f.manager.ensureSession(ACTOR, "User");
    expect(f.engine.submit).toHaveBeenCalledWith(expect.stringContaining("Launch marker"));
    expect(f.provenance.recordAdmission).toHaveBeenCalledTimes(1);
  });

  it("keeps empty launch memory, bound replay, persona, user text and attachment metadata clean", async () => {
    const f = fixture({ recall: { recall: async () => ({ episodicChunks: [], facts: [] }) } });
    vi.mocked(f.deps.persistence.listPriorTurns).mockResolvedValue({
      recent: [{ role: "assistant", content: "Prior turn" }],
      oldSummary: "Older summary"
    });
    await f.manager.submitTurn(ACTOR, "User", "User-authored marker", {
      attachments: [
        {
          id: "attachment-1",
          fileName: "user-file.txt",
          mimeType: "text/plain",
          sizeBytes: 16,
          createdAt: "2026-10-01T00:00:00Z"
        }
      ]
    });
    expect(f.engine.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        personaText: "Trusted persona",
        replayBatch: expect.stringContaining("Prior turn")
      })
    );
    expect(f.engine.submit).toHaveBeenCalledWith(
      expect.stringContaining("attachmentId=attachment-1")
    );
    expect(f.provenance.recordAdmission).not.toHaveBeenCalled();
  });

  it("opening a new conversation after outside recall leaves the new session clean", async () => {
    let recalled = "Outside marker";
    const f = fixture({ passiveRetrieval: { retrieve: async () => recalled } });
    await f.manager.submitTurn(ACTOR, "User", "Remember this");
    expect(await f.provenance.isTainted(ACTOR, "thread-a")).toBe(true);
    await f.manager.clear(ACTOR);
    recalled = "";
    await f.manager.submitTurn(ACTOR, "User", "Hello");
    expect(await f.provenance.isTainted(ACTOR, "thread-b")).toBe(false);
    expect(f.provenance.recordAdmission).toHaveBeenCalledExactlyOnceWith(
      ACTOR,
      "thread-a",
      "recall_memory_turn"
    );
  });

  it.each(["seed_route", "evening_seed"] as const)(
    "admits %s before submitting and deduplicates the seed",
    async (path) => {
      const f = fixture();
      f.engine.submit.mockImplementation(async () => {
        expect(f.provenance.recordAdmission).toHaveBeenCalledWith(ACTOR, "thread-a", path);
      });
      await f.manager.seedContext(ACTOR, "User", "Seed marker", "key", DEFAULT_CHAT_SURFACE, path);
      await f.manager.seedContext(ACTOR, "User", "Seed marker", "key", DEFAULT_CHAT_SURFACE, path);
      expect(f.engine.submit).toHaveBeenCalledTimes(1);
      expect(f.provenance.recordAdmission).toHaveBeenCalledTimes(1);
    }
  );

  it("records request module control but persists only the user text", async () => {
    const f = fixture();
    await f.manager.submitTurn(ACTOR, "User", "User message", { moduleControl: "Module marker" });
    expect(f.provenance.recordAdmission).toHaveBeenCalledExactlyOnceWith(
      ACTOR,
      "thread-a",
      "module_control_context"
    );
    expect(f.engine.submit).toHaveBeenCalledWith(expect.stringContaining("Module marker"));
    expect(f.deps.persistence.recordTurn).toHaveBeenCalledWith(
      ACTOR,
      "User message",
      expect.any(String),
      expect.any(Object),
      expect.any(Object),
      DEFAULT_CHAT_SURFACE
    );
  });

  it.each(["launch_memory_seed", "seed_route", "evening_seed", "module_control_context"] as const)(
    "blocks %s when recording fails",
    async (path: AdmissionPath) => {
      const f = fixture({
        conversationProvenance: {
          recordAdmission: async () => {
            throw new Error("record failed");
          }
        },
        ...(path === "launch_memory_seed"
          ? {
              recall: {
                recall: async () => ({
                  episodicChunks: [],
                  facts: [{ category: "project", content: "Unrecorded launch" }]
                })
              }
            }
          : {})
      });
      const call =
        path === "launch_memory_seed"
          ? f.manager.ensureSession(ACTOR, "User")
          : path === "module_control_context"
            ? f.manager.submitTurn(ACTOR, "User", "hello", { moduleControl: "Unrecorded control" })
            : f.manager.seedContext(
                ACTOR,
                "User",
                "Unrecorded seed",
                undefined,
                DEFAULT_CHAT_SURFACE,
                path as "seed_route" | "evening_seed"
              );
      await expect(call).rejects.toThrow("provenance could not be recorded");
      expect(f.engine.submit).not.toHaveBeenCalled();
      if (path === "launch_memory_seed") expect(f.engine.launch).not.toHaveBeenCalled();
    }
  );
});

describe("permission-free outside-agent launch", () => {
  function outsideAgent() {
    const engine = new AcpChatEngine("openai-compatible", "acp-session", {
      userId: ACTOR,
      projectId: "thread-a",
      tunnel: {} as never
    });
    const launch = vi.spyOn(engine, "launch").mockResolvedValue({ offset: 0 });
    const kill = vi.spyOn(engine, "kill").mockResolvedValue(undefined);
    return { engine, launch, kill };
  }

  it("records the actual ACP engine marker before launch even with no acpAgentId", async () => {
    const acp = outsideAgent();
    let release!: () => void;
    const recordAdmission = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const f = fixture({
      engineFactory: () => acp.engine,
      conversationProvenance: { recordAdmission }
    });
    const pending = f.manager.ensureSession(ACTOR, "User");
    await vi.waitFor(() =>
      expect(recordAdmission).toHaveBeenCalledExactlyOnceWith(
        ACTOR,
        "thread-a",
        "outside_agent_launch"
      )
    );
    expect(acp.launch).not.toHaveBeenCalled();
    release();
    await pending;
    expect(acp.launch).toHaveBeenCalledOnce();
  });

  it("failed ACP launch admission revokes its token and never spawns an agent", async () => {
    const acp = outsideAgent();
    const revokeMcpToken = vi.fn();
    const f = fixture({
      engineFactory: () => acp.engine,
      mintMcpToken: async () => ({ token: "jst_test", mcpServerUrl: "http://localhost/api/mcp" }),
      revokeMcpToken,
      conversationProvenance: {
        recordAdmission: async () => {
          throw new Error("private storage sentinel");
        }
      }
    });
    await expect(f.manager.ensureSession(ACTOR, "User")).rejects.toThrow(
      "Conversation provenance could not be recorded"
    );
    expect(acp.launch).not.toHaveBeenCalled();
    expect(acp.kill).toHaveBeenCalledOnce();
    expect(revokeMcpToken).toHaveBeenCalledExactlyOnceWith(surfaceSessionKey(ACTOR));
  });

  it("missing ACP binding refuses launch rather than tainting a selected thread later", async () => {
    const acp = outsideAgent();
    const f = fixture();
    const recordAdmission = vi.fn(async () => undefined);
    const manager = new ChatSessionManager({
      ...f.deps,
      engineFactory: () => acp.engine,
      conversationProvenance: { recordAdmission },
      persistence: { ...f.deps.persistence, getCurrentThreadState: async () => undefined }
    });
    await expect(manager.ensureSession(ACTOR, "User")).rejects.toThrow("binding is unavailable");
    expect(acp.launch).not.toHaveBeenCalled();
    expect(recordAdmission).not.toHaveBeenCalled();
  });
});
