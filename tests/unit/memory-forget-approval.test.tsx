import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dataContextBrand,
  type AccessContext,
  type DataContextDb,
  type DataContextRunner
} from "@moss/db";
import type { MossModuleManifest, ToolContext } from "@moss/module-sdk";
import { ActionRequestCard } from "../../apps/web/src/chat/action-request-card.js";
import { parseRecord } from "../../apps/web/src/chat/use-chat-stream.js";
import { ConfirmationRegistry } from "../../packages/ai/src/gateway/confirmation-registry.js";
import { CONTEXT_ADMISSION_UNAVAILABLE } from "../../packages/ai/src/gateway/content-admission.js";
import {
  AssistantToolGateway,
  type AssistantToolGatewayDependencies
} from "../../packages/ai/src/gateway/gateway.js";
import { APPROVAL_REFUSED_REASON } from "../../packages/ai/src/gateway/native-tool-guard.js";
import { SessionTokenRegistry } from "../../packages/ai/src/gateway/session-tokens.js";
import type { AdmissionPath, GatewaySessionRecord } from "../../packages/ai/src/gateway/types.js";
import type { AiRepository } from "../../packages/ai/src/repository.js";
import { buildChatGatewayDependencies } from "../../packages/chat/src/gateway-services.js";
import { factLabel } from "../../packages/memory/src/chat-targets.js";
import {
  MemoryForgetService,
  type MemoryForgetToolService
} from "../../packages/memory/src/forget-service.js";
import { memoryModuleManifest } from "../../packages/memory/src/manifest.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const FACT_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_FACT_ID = "44444444-4444-4444-8444-444444444444";
const VERSION = "server-only-original-memory-version";
const RETRY =
  "The memory changed or is no longer available. Find it again and review a new request.";
const CONSENT_OFF =
  "Memory AI consent is off. Review it in Settings before requesting this action again.";
const DEFAULT_LABEL = `Mira: prefers: green tea [fact ${FACT_ID}]`;
type ActionRequest = Extract<GatewaySessionRecord, { kind: "action_request" }>;
type ActorDb = DataContextDb & { actorUserId: string };

function build(
  options: {
    label?: string;
    yolo?: boolean;
    consentHook?: boolean;
    dependencies?: Partial<AssistantToolGatewayDependencies>;
  } = {}
) {
  const state = {
    enabled: true,
    consent: true,
    exists: true,
    owner: OWNER,
    version: VERSION,
    label: options.label ?? DEFAULT_LABEL,
    admissionError: false,
    admissionWait: undefined as Promise<void> | undefined,
    tainted: false
  };
  const order: string[] = [];
  const records: GatewaySessionRecord[] = [];
  const scopedActors: string[] = [];
  const runner = {
    withDataContext: async <T,>(access: AccessContext, work: (db: DataContextDb) => Promise<T>) => {
      scopedActors.push(access.actorUserId);
      const db = {
        actorUserId: access.actorUserId,
        [dataContextBrand]: true,
        db: {
          selectFrom: (table: string) => {
            if (!["app.instance_settings", "app.preferences"].includes(table)) {
              throw new Error(`Unexpected unit-test DB table: ${table}`);
            }
            const query = {
              select: () => query,
              where: () => query,
              executeTakeFirst: async () => ({ value: { enabled: options.yolo === true } }),
              execute: async () => [
                { key: "yolo.allowed", value_json: options.yolo === true },
                { key: "yolo.enabled", value_json: options.yolo === true }
              ]
            };
            return query;
          }
        }
      } as unknown as ActorDb;
      return work(db);
    }
  } as DataContextRunner;
  const target = vi
    .spyOn(MemoryForgetService.prototype, "target")
    .mockImplementation(async (db, owner, factId) => {
      order.push("target");
      expect((db as ActorDb).actorUserId).toBe(owner);
      return state.exists && owner === state.owner && factId === FACT_ID
        ? { label: state.label, version: state.version }
        : null;
    });
  const forgetApproved = vi
    .spyOn(MemoryForgetService.prototype, "forgetApproved")
    .mockImplementation(async (db, owner, factId, version) => {
      order.push("delete");
      expect((db as ActorDb).actorUserId).toBe(owner);
      if (!state.exists || owner !== state.owner || factId !== FACT_ID || version !== state.version)
        return false;
      state.exists = false;
      return true;
    });
  // Memory currently has no consent hook. Exercise the generic composition hook without
  // replacing its resolver, capability, tool executor, policy, or approval machinery.
  const module: MossModuleManifest = options.consentHook
    ? {
        ...memoryModuleManifest,
        aiConsent: {
          key: "test.memory.consent",
          isGranted: async (db, actor) => {
            expect((db as ActorDb).actorUserId).toBe(actor);
            return state.consent;
          }
        }
      }
    : memoryModuleManifest;
  const resolveActiveModules = async () => (state.enabled ? [module] : []);
  let pendingRow: { id: string; owner: string; status: string } | undefined;
  const createPending = vi.fn(async (db: DataContextDb, _input: unknown) => {
    order.push("pending");
    pendingRow = { id: "memory-action-1", owner: (db as ActorDb).actorUserId, status: "pending" };
    return pendingRow;
  });
  const audit = vi.fn(async () => undefined);
  const repository = {
    createPendingAssistantAction: createPending,
    insertActionAuditLog: audit,
    getAssistantAction: async (db: DataContextDb, id: string) =>
      pendingRow?.id === id && pendingRow.owner === (db as ActorDb).actorUserId ? pendingRow : null,
    resolveAssistantAction: async (db: DataContextDb, id: string, input: { status: string }) => {
      if (
        pendingRow?.id !== id ||
        pendingRow.owner !== (db as ActorDb).actorUserId ||
        pendingRow.status !== "pending"
      )
        return null;
      pendingRow.status = input.status;
      return pendingRow;
    }
  } as unknown as AiRepository;
  const recordAdmission = vi.fn(async (actor: string, thread: string, path: AdmissionPath) => {
    expect(actor).toBe(OWNER);
    expect(thread).toBe("memory-thread");
    order.push(`admit:${path}`);
    if (state.admissionWait) await state.admissionWait;
    if (state.admissionError) throw new Error(`PRIVATE admission failure: ${state.label}`);
    state.tainted = true;
    order.push(`admitted:${path}`);
  });
  const tokens = new SessionTokenRegistry();
  const confirmations = new ConfirmationRegistry();
  const deps = buildChatGatewayDependencies({
    runner,
    repository,
    tokens,
    confirmations,
    resolveActiveModules,
    conversationProvenance: { isTainted: async () => state.tainted, recordAdmission },
    notifier: {
      emit: (_sessionId, record) => {
        order.push(record.kind);
        records.push(record);
      }
    },
    collaborators: {}
  });
  const gateway = new AssistantToolGateway({
    ...deps,
    confirmTimeoutMs: 2_000,
    ...options.dependencies
  });
  const token = tokens.mint({
    actorUserId: OWNER,
    chatSessionId: "memory-session",
    threadId: "memory-thread",
    allowedToolNames: null
  });
  return {
    state,
    order,
    records,
    scopedActors,
    target,
    forgetApproved,
    createPending,
    audit,
    recordAdmission,
    confirmations,
    deps,
    gateway,
    token
  };
}

async function card(h: ReturnType<typeof build>): Promise<ActionRequest> {
  await vi.waitFor(
    () => {
      expect(h.records[0]?.kind).toBe("action_request");
      expect(h.confirmations.isAwaiting("memory-action-1")).toBe(true);
    },
    { interval: 1, timeout: 1_000 }
  );
  return h.records[0] as ActionRequest;
}

async function resolve(h: ReturnType<typeof build>, status: "confirmed" | "rejected") {
  expect(await h.gateway.resolveActionRequest(OWNER, "memory-action-1", status)).toBe("resolved");
}

function expectNoCardOrDelete(h: ReturnType<typeof build>) {
  expect(h.createPending).not.toHaveBeenCalled();
  expect(h.records).toEqual([]);
  expect(h.forgetApproved).not.toHaveBeenCalled();
}

function expectRenderedTarget(record: ActionRequest, expected: string) {
  const parsed = parseRecord(JSON.stringify({ ...record, text: record.summary }));
  expect(parsed?.details?.target).toBe(expected);
  if (!parsed) throw new Error("Expected a parseable action request");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(ActionRequestCard, {
        actionRequestId: record.actionRequestId,
        toolName: record.toolName,
        summary: record.summary,
        details: parsed.details,
        outsideContentNotice: parsed.outsideContentNotice
      })
    )
  );
  const escaped = expected
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
  expect(html).toContain(`<q>${escaped}</q>`);
  expect(html).toContain(
    'class="action-request-preview__value action-request-preview__value--multiline"'
  );
  expect(html).toContain(FACT_ID);
  expect(html).not.toContain("<script>");
  expect(html).toContain("outside or unverified context");
  expect(html).toContain("Approve");
  expect(html).toContain("Reject");
  client.clear();
}

afterEach(() => vi.restoreAllMocks());

describe("legacy memory.forget approval binding", () => {
  it("emits and renders the complete long multiline memory and exact fact ID", async () => {
    const text = `First line <script>never execute()</script> & "quotes"\n${"Full memory text must survive. ".repeat(180)}\nFinal line **literal markup**`;
    const label = `Mira: remembers: ${text} [fact ${FACT_ID}]`;
    const h = build({ label });
    const pending = h.gateway.callTool(h.token, "memory.forget", { factId: FACT_ID });
    const request = await card(h);
    expect(request).toEqual({
      kind: "action_request",
      actionRequestId: "memory-action-1",
      toolName: "memory.forget",
      summary: "Forget saved memory",
      details: { target: label, fields: [] },
      outsideContentNotice: true
    });
    expectRenderedTarget(request, label);
    expect(request).not.toHaveProperty("targetVersion");
    expect(h.target).toHaveBeenCalledWith(expect.anything(), OWNER, FACT_ID);
    expect(h.forgetApproved).not.toHaveBeenCalled();
    const saved = h.createPending.mock.calls[0]?.[1];
    expect(saved).toMatchObject({
      inputSummary: { inputKeys: ["factId"], inputKeyCount: 1, truncated: false },
      risk: "destructive"
    });
    expect(JSON.stringify(saved)).not.toContain(text);
    expect(JSON.stringify(saved)).not.toContain(VERSION);
    expect(JSON.stringify(saved)).not.toContain(FACT_ID);
    await resolve(h, "rejected");
    await expect(pending).resolves.toEqual({
      ok: false,
      denied: true,
      reason: APPROVAL_REFUSED_REASON
    });
    expect(h.forgetApproved).not.toHaveBeenCalled();
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(text);
    expect(JSON.stringify(h.audit.mock.calls)).not.toContain(VERSION);
  });

  it("emits and renders an entity-backed memory with both entity names and its exact fact ID", async () => {
    const label = factLabel({
      id: FACT_ID,
      subject_entity_id: OWNER,
      subject_name: "Mira",
      predicate: "works with",
      object_entity_id: OTHER_OWNER,
      object_text: null,
      object_name: "Jo <Research & Development>"
    });
    const expected = `Mira: works with: Jo <Research & Development> [fact ${FACT_ID}]`;
    const h = build({ label });
    const pending = h.gateway.callTool(h.token, "memory.forget", { factId: FACT_ID });
    const request = await card(h);
    expect(request.details).toEqual({ target: expected, fields: [] });
    expectRenderedTarget(request, expected);
    await resolve(h, "rejected");
    await pending;
  });

  it.each([false, true])(
    "waits for approval even with YOLO=%s, then deletes only the approved original version",
    async (yolo) => {
      const h = build({ yolo });
      await expect(
        h.deps.yoloMode!({
          actorUserId: OWNER,
          requestId: "yolo-check",
          chatSessionId: "memory-session"
        })
      ).resolves.toBe(yolo);
      const pending = h.gateway.callTool(h.token, "memory.forget", { factId: FACT_ID });
      await card(h);
      expect(h.state.exists).toBe(true);
      expect(h.forgetApproved).not.toHaveBeenCalled();
      await resolve(h, "confirmed");
      await expect(pending).resolves.toMatchObject({ ok: true, structuredData: { deleted: true } });
      expect(h.forgetApproved).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        OWNER,
        FACT_ID,
        VERSION
      );
      expect(h.records[1]).toMatchObject({
        kind: "action_result",
        outcome: "executed",
        result: {
          text: '<tool_result source="memory.forget">\n{\n  &quot;deleted&quot;: true\n}\n</tool_result>'
        },
        affectsModules: ["memory"]
      });
      expect(h.state.exists).toBe(false);
      expect(h.scopedActors.every((actor) => actor === OWNER)).toBe(true);
    }
  );

  it.each(["wrong owner", "missing memory", "different fact"])(
    "withholds approval and deletion for a %s",
    async (failure) => {
      const h = build();
      if (failure === "wrong owner") h.state.owner = OTHER_OWNER;
      if (failure === "missing memory") h.state.exists = false;
      await expect(
        h.gateway.callTool(h.token, "memory.forget", {
          factId: failure === "different fact" ? OTHER_FACT_ID : FACT_ID
        })
      ).resolves.toEqual({ ok: false, denied: true, reason: "unknown_route" });
      expectNoCardOrDelete(h);
    }
  );

  it.each(["not-a-uuid", "", "33333333-3333-4333-8333-333333333333' OR TRUE"])(
    "rejects invalid fact ID %j before lookup",
    async (factId) => {
      const h = build();
      await expect(h.gateway.callTool(h.token, "memory.forget", { factId })).resolves.toEqual({
        ok: false,
        denied: true,
        reason: "unknown_route"
      });
      expect(h.target).not.toHaveBeenCalled();
      expectNoCardOrDelete(h);
    }
  );

  it.each([
    { input: {}, error: "Tool memory.forget: Missing required field: factId" },
    { input: { factId: 5 }, error: "Tool memory.forget: Field factId must be a string" }
  ])("rejects malformed input $input before lookup", async ({ input, error }) => {
    const h = build();
    await expect(h.gateway.callTool(h.token, "memory.forget", input)).resolves.toEqual({
      ok: false,
      error
    });
    expect(h.target).not.toHaveBeenCalled();
    expectNoCardOrDelete(h);
  });

  it("withholds lookup exceptions and never emits a blind approval card", async () => {
    const h = build();
    h.target.mockRejectedValueOnce(new Error(`PRIVATE target lookup: ${DEFAULT_LABEL}`));
    await expect(
      h.gateway.callTool(h.token, "memory.forget", { factId: FACT_ID })
    ).resolves.toEqual({ ok: false, denied: true, reason: "not_ready" });
    expectNoCardOrDelete(h);
  });

  it.each(["resolver", "binding", "bound service", "executor", "registry service"])(
    "fails closed when the %s is missing from production composition",
    async (missing) => {
      const dependencies: Partial<AssistantToolGatewayDependencies> =
        missing === "resolver"
          ? { perCallResolvers: {} }
          : missing === "binding"
            ? { perCallServices: {} }
            : missing === "bound service"
              ? { perCallServices: { "memory.forget": () => ({}) } }
              : missing === "executor"
                ? { perCallExecutors: {} }
                : { toolServices: {} };
      const h = build({ dependencies });
      await expect(
        h.gateway.callTool(h.token, "memory.forget", { factId: FACT_ID })
      ).resolves.toEqual(
        missing === "registry service"
          ? { ok: false, error: "Tool not available: memory.forget" }
          : { ok: false, denied: true, reason: "not_ready" }
      );
      expectNoCardOrDelete(h);
    }
  );

  it.each(["changed version", "deleted memory"])(
    "returns the fixed retry guidance for an approved %s",
    async (change) => {
      const h = build();
      const pending = h.gateway.callTool(h.token, "memory.forget", { factId: FACT_ID });
      await card(h);
      if (change === "changed version") {
        h.state.version = "replacement-version";
        h.state.label = "PRIVATE replacement target";
      } else h.state.exists = false;
      await resolve(h, "confirmed");
      await expect(pending).resolves.toEqual({ ok: false, error: RETRY });
      expect(h.forgetApproved).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        OWNER,
        FACT_ID,
        VERSION
      );
      expect(h.target).toHaveBeenCalledOnce();
      expect(h.records[1]).toMatchObject({
        kind: "action_result",
        outcome: "error",
        reason: RETRY
      });
      expect(h.records[1]).not.toHaveProperty("affectsModules");
      expect(JSON.stringify(h.records)).not.toContain("PRIVATE replacement target");
      if (change === "changed version") expect(h.state.exists).toBe(true);
    }
  );

  it("keeps the original input snapshot when caller input changes during approval", async () => {
    const h = build();
    const input = { factId: FACT_ID };
    const pending = h.gateway.callTool(h.token, "memory.forget", input);
    await card(h);
    input.factId = OTHER_FACT_ID;
    await resolve(h, "confirmed");
    await expect(pending).resolves.toMatchObject({ ok: true, structuredData: { deleted: true } });
    expect(h.forgetApproved).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      OWNER,
      FACT_ID,
      VERSION
    );
  });

  it("binds a single-use capability to the original actor, fact and context", async () => {
    const h = build();
    const input = Object.freeze({ factId: FACT_ID });
    const ctx: ToolContext = Object.freeze({
      actorUserId: OWNER,
      requestId: "bound-request",
      chatSessionId: "memory-session",
      threadId: "memory-thread"
    });
    const resolution = await h.deps.perCallResolvers!["memory.forget"]!(input, ctx);
    expect(resolution.kind).toBe("proceed");
    if (resolution.kind !== "proceed") throw new Error("Expected memory target resolution");
    expect(resolution.targetVersion).toBe(VERSION);
    const service = h.deps.perCallServices!["memory.forget"]!(input, ctx, resolution)
      .memoryForget as MemoryForgetToolService;
    await expect(service.forget(FACT_ID, { ...ctx, actorUserId: OTHER_OWNER })).rejects.toThrow(
      RETRY
    );
    await expect(service.forget(OTHER_FACT_ID, ctx)).rejects.toThrow(RETRY);
    await expect(
      service.forget(FACT_ID, { ...ctx, requestId: "different-request" })
    ).rejects.toThrow(RETRY);
    expect(h.forgetApproved).not.toHaveBeenCalled();
    await expect(service.forget(FACT_ID, ctx)).resolves.toEqual({ deleted: true });
    await expect(service.forget(FACT_ID, ctx)).rejects.toThrow(RETRY);
    expect(h.forgetApproved).toHaveBeenCalledOnce();
  });

  it("does not let another actor approve the pending memory request", async () => {
    const h = build();
    const pending = h.gateway.callTool(h.token, "memory.forget", { factId: FACT_ID });
    await card(h);
    expect(await h.gateway.resolveActionRequest(OTHER_OWNER, "memory-action-1", "confirmed")).toBe(
      "not_found"
    );
    expect(h.confirmations.isAwaiting("memory-action-1")).toBe(true);
    expect(h.forgetApproved).not.toHaveBeenCalled();
    await resolve(h, "rejected");
    await pending;
  });

  it.each(["disabled module", "revoked consent"])(
    "rechecks %s before executing an approved request",
    async (change) => {
      const h = build({ consentHook: true });
      const pending = h.gateway.callTool(h.token, "memory.forget", { factId: FACT_ID });
      await card(h);
      if (change === "disabled module") h.state.enabled = false;
      else h.state.consent = false;
      await resolve(h, "confirmed");
      await expect(pending).resolves.toEqual({
        ok: false,
        error: change === "disabled module" ? RETRY : CONSENT_OFF
      });
      expect(h.forgetApproved).not.toHaveBeenCalled();
      expect(h.state.exists).toBe(true);
      expect(h.records[1]).toMatchObject({
        kind: "action_result",
        outcome: "error",
        reason: change === "disabled module" ? RETRY : CONSENT_OFF
      });
    }
  );

  it("refuses consent-off requests before lookup or approval", async () => {
    const h = build({ consentHook: true });
    h.state.consent = false;
    await expect(
      h.gateway.callTool(h.token, "memory.forget", { factId: FACT_ID })
    ).resolves.toEqual({ ok: false, denied: true, reason: "consent_off" });
    expect(h.target).not.toHaveBeenCalled();
    expectNoCardOrDelete(h);
  });

  it("finishes outside-content admission before persisting or emitting the approval", async () => {
    const h = build();
    let admit!: () => void;
    h.state.admissionWait = new Promise<void>((resolveAdmission) => {
      admit = resolveAdmission;
    });
    const pending = h.gateway.callTool(h.token, "memory.forget", { factId: FACT_ID });
    await vi.waitFor(() => expect(h.recordAdmission).toHaveBeenCalledOnce(), { interval: 1 });
    expectNoCardOrDelete(h);
    expect(h.order).toEqual(["target", "admit:tool_external_content"]);
    admit();
    const request = await card(h);
    expect(h.order).toEqual([
      "target",
      "admit:tool_external_content",
      "admitted:tool_external_content",
      "pending",
      "action_request"
    ]);
    expect(request.outsideContentNotice).toBe(true);
    await resolve(h, "rejected");
    await pending;
  });

  it("withholds all target text and the action when outside-content admission fails", async () => {
    const h = build();
    h.state.admissionError = true;
    const response = await h.gateway.callTool(h.token, "memory.forget", { factId: FACT_ID });
    expect(response).toEqual({ ok: false, error: CONTEXT_ADMISSION_UNAVAILABLE });
    expect(h.target).toHaveBeenCalledOnce();
    expect(h.recordAdmission).toHaveBeenCalledExactlyOnceWith(
      OWNER,
      "memory-thread",
      "tool_external_content"
    );
    expectNoCardOrDelete(h);
    expect(h.state.exists).toBe(true);
    expect(JSON.stringify(response)).not.toContain(DEFAULT_LABEL);
    expect(JSON.stringify(response)).not.toContain(VERSION);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
