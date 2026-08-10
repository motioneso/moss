import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord
} from "@moss/ai";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { ChatSkillDto } from "@moss/shared";

import { composeTurnText } from "../../apps/web/src/chat/skill-autocomplete.js";
import { renderPersona, type PersonaFs } from "../../packages/chat/src/live/persona.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { exampleToolCalls, exampleToolModule } from "./fixtures/example-tool-module.js";

/**
 * #760 Task 6 — proves skill-triggered tool calls get NO special server-side path.
 *
 * Skill invocation is 100% client-side text composition (composeTurnText prepends the skill
 * body to the submitted turn text; see apps/web/src/chat/skill-autocomplete.tsx). By the time
 * that text becomes a tool call, it arrives at AssistantToolGateway.callTool(token, toolName,
 * rawInput) — a signature with no origin/skill field, so there is nowhere for a skill-aware
 * branch to live. These tests reuse the exact confirm-gated and YOLO fixtures from
 * mcp-gateway.test.ts, but with the tool-call value sourced from composeTurnText output, to
 * prove the pipeline treats skill-sourced content identically to plain user text.
 */

function skillFixture(overrides: Partial<ChatSkillDto> = {}): ChatSkillDto {
  return {
    id: "skill-cleanup",
    ownerUserId: ids.userA,
    name: "cleanup",
    description: null,
    frontmatter: {},
    body: "Always confirm before writing or deleting anything on the user's behalf.",
    enabled: true,
    source: "authored",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides
  };
}

function fakePersonaFs(): { fs: PersonaFs; writes: Record<string, string>; calls: string[] } {
  const writes: Record<string, string> = {};
  const calls: string[] = [];
  const fs: PersonaFs = {
    mkdir: async (path: string) => {
      calls.push(`mkdir:${path}`);
    },
    writeFile: async (path: string, content: string) => {
      writes[path] = content;
      calls.push(`writeFile:${path}`);
    }
  };
  return { fs, writes, calls };
}

describe("skill-sourced turns at the gateway boundary (#760 Task 6)", () => {
  let appDb: Kysely<MossDatabase>;
  let bootstrapDb: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  let repository: AiRepository;
  let tokens: SessionTokenRegistry;
  let confirmations: ConfirmationRegistry;
  let emitted: { chatSessionId: string; record: GatewaySessionRecord }[];
  let gateway: AssistantToolGateway;

  function firstActionRequest(): { actionRequestId: string; toolName: string; summary: string } {
    const entry = emitted[0];
    if (!entry || entry.record.kind !== "action_request") {
      throw new Error("expected an action_request card to have been emitted");
    }
    return entry.record;
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    bootstrapDb = createDatabase({
      connectionString: connectionStrings.bootstrap,
      maxConnections: 1
    });
    runner = new DataContextRunner(appDb);
    repository = new AiRepository();
  });

  afterAll(async () => {
    await bootstrapDb.destroy();
    await appDb.destroy();
  });

  beforeEach(() => {
    exampleToolCalls.length = 0;
    // #1308 defect 2: build the array as a local `sink` first and close the shared gateway's
    // notifier over that local, not over the outer `emitted` binding. `emitted` is a `let` that
    // every beforeEach reassigns to a new array; if the notifier closed over `emitted` instead,
    // a call left dangling by a failed assertion in a prior test could still emit into whatever
    // array `emitted` points to by the time it settles — i.e. a LATER test's array. Assigning
    // `emitted = sink` keeps every test's existing `emitted`/`firstActionRequest()` reads
    // working unchanged.
    const sink: { chatSessionId: string; record: GatewaySessionRecord }[] = [];
    emitted = sink;
    tokens = new SessionTokenRegistry();
    confirmations = new ConfirmationRegistry();
    gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [exampleToolModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => sink.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000
    });
  });

  afterEach(async () => {
    // #1308 defect 2/3 belt-and-suspenders: an assertion thrown between issuing a confirm-gated
    // call and reaching its own resolveActionRequest/`await call` cleanup leaves that call
    // blocked on the ConfirmationRegistry waiter. Sink isolation above stops its late emit from
    // landing in a later test's array, but the call itself should still be settled rather than
    // left in flight. Cancel every action_request this test emitted; resolveActionRequest is a
    // documented no-op once a row is no longer pending (or owned by a different actor), so
    // trying both fixture actors on every outstanding id cannot disturb an unrelated row.
    for (const entry of emitted) {
      if (entry.record.kind !== "action_request") continue;
      await Promise.all(
        [ids.userA, ids.userB].map((actorUserId) =>
          gateway.resolveActionRequest(actorUserId, entry.record.actionRequestId, "cancelled")
        )
      );
    }
  });

  it("blocks a skill-sourced write until approved — identical to a plain-text write", async () => {
    const turnText = composeTurnText(skillFixture(), "please write hello for me");
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-skill-write",
      allowedToolNames: null
    });

    const call = gateway.callTool(token, "example.write", { value: turnText });
    // #1308: wait on the condition actually being awaited (the action_request card has
    // landed) instead of a fixed 50ms delay. Emitting an action_request does DB round-trips,
    // so a fixed sleep can elapse before the emit lands on a loaded CI runner and read a stale
    // (empty) array.
    await vi.waitFor(() => {
      expect(emitted).toHaveLength(1);
    });

    // Pending, never silently executed — the gateway has no skill-origin field to branch on.
    expect(emitted).toHaveLength(1);
    const card = firstActionRequest();
    expect(card.toolName).toBe("example.write");
    expect(exampleToolCalls).toHaveLength(0);

    await gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");
    const res = await call;

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    // The composed skill-body-prefixed text flows through unmodified — no stripping/parsing.
    expect(exampleToolCalls).toEqual([
      { name: "example.write", input: { value: turnText }, actorUserId: ids.userA }
    ]);
    expect(emitted.map((entry) => entry.record.kind)).toEqual(["action_request", "action_result"]);
  });

  it("auto-runs a skill-sourced destructive call under YOLO — same audit trail as any other call", async () => {
    const yoloGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [exampleToolModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      yoloMode: async () => true
    });
    const turnText = composeTurnText(skillFixture(), "clean up the stale draft, delete it");
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-skill-yolo",
      allowedToolNames: null
    });

    const result = await yoloGateway.callTool(token, "example.destroy", { value: turnText });
    // #1308: condition wait, not a fixed delay — same fix as above. The gateway's own promise
    // can resolve before its notifier's emit (a DB-backed audit write) settles.
    await vi.waitFor(() => {
      expect(emitted.map((entry) => entry.record.kind)).toEqual(["action_result"]);
    });

    expect(result.ok).toBe(true);
    expect(exampleToolCalls).toEqual([
      { name: "example.destroy", input: { value: turnText }, actorUserId: ids.userA }
    ]);
    expect(emitted.map((entry) => entry.record.kind)).toEqual(["action_result"]);

    const audit = await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "test:skill-yolo-audit" },
      (scopedDb) => repository.listActionAuditLog(scopedDb, { since: new Date(0), limit: 20 })
    );
    // approval_mode stays plain "yolo" — no separate skill-triggered audit label exists.
    expect(
      audit.some((row) => row.tool_name === "example.destroy" && row.approval_mode === "yolo")
    ).toBe(true);
  });

  it("persona file bytes are byte-identical before and after a skill-sourced turn", async () => {
    const { fs, writes, calls } = fakePersonaFs();
    const persona = "You are Jarvis, {{userName}}'s assistant.";
    const rendered = await renderPersona(fs, {
      sessionKey: ids.userA,
      userName: "Ben",
      provider: "anthropic",
      baseDir: "/skill-persona-test",
      persona
    });
    const before = writes[rendered.personaPath];
    const callsBefore = [...calls];
    expect(before).toBeDefined();

    // Run a full skill-sourced turn through the gateway (confirm-gated write). AssistantToolGateway's
    // dependency surface (repository/runner/tokens/confirmations/notifier/actionPolicy/yoloMode) has
    // no PersonaFs seam at all, so nothing on this path can reach the persona file.
    const turnText = composeTurnText(skillFixture(), "please write hello for me");
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-skill-persona",
      allowedToolNames: null
    });
    const call = gateway.callTool(token, "example.write", { value: turnText });
    // #1308: condition wait, not a fixed delay — same fix as above.
    await vi.waitFor(() => {
      expect(emitted).toHaveLength(1);
    });
    const card = firstActionRequest();
    await gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");
    await call;

    // No new mkdir/writeFile occurred as a side effect of the skill-sourced tool call.
    expect(calls).toEqual(callsBefore);

    // Re-rendering the same persona input is idempotent and byte-identical (prompt-cache
    // discipline: skill invocation must never cause persona-file rewrite/drift).
    const renderedAgain = await renderPersona(fs, {
      sessionKey: ids.userA,
      userName: "Ben",
      provider: "anthropic",
      baseDir: "/skill-persona-test",
      persona
    });
    expect(writes[renderedAgain.personaPath]).toBe(before);
  });
});
