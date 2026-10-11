import Fastify from "fastify";
import type { PgBoss } from "pg-boss";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AccessContext,
  DataContextDb,
  DataContextRunner,
  UsefulnessFeedbackSignal
} from "@moss/db";
import {
  createUsefulnessFeedbackSignalRequestSchema,
  type CreateUsefulnessFeedbackRequest
} from "@moss/shared";
import {
  buildCalendarFollowThroughSideEffects,
  buildStoryPreferenceRefresh
} from "../../packages/module-registry/src/index.js";
import {
  assertRouteChatClassification,
  buildRouteCatalog
} from "../../packages/module-registry/src/route-catalog.js";
import {
  FeedbackTargetVerifierRegistry,
  registerUsefulnessFeedbackRoutes,
  usefulnessFeedbackModuleManifest,
  type FeedbackTargetVerification,
  type UsefulnessFeedbackRepository
} from "../../packages/usefulness-feedback/src/index.js";
import type { CreateFeedbackInput } from "../../packages/usefulness-feedback/src/repository.js";

const access: AccessContext = { actorUserId: "owner", requestId: "record-only-feedback" };
const scopedDb = {} as DataContextDb;
const targetRef = "calendar:prep:1";
const signalPath = "/api/me/usefulness-feedback/signals";
const uiPath = "/api/me/usefulness-feedback";
const metadata = {
  calendarFollowThrough: { targetRef, taskId: "task-1", calendarEventId: "event-1" },
  summary: "Must not be copied to metadata"
};
const accepted: CreateUsefulnessFeedbackRequest[] = [
  { targetKind: "chat_message", surface: "chat", kind: "more_like_this", targetRef },
  { targetKind: "chat_message", surface: "chat", kind: "not_useful", targetRef },
  ...(["more_like_this", "too_much", "not_useful", "dismiss"] as const).map((kind) => ({
    targetKind: "briefing_run" as const,
    surface: "briefing" as const,
    kind,
    targetRef
  })),
  ...(["briefing", "today"] as const).flatMap((surface) =>
    (["more_like_this", "too_much", "wrong_priority", "dismiss"] as const).map((kind) => ({
      targetKind: "briefing_item" as const,
      surface,
      kind,
      targetRef
    }))
  ),
  ...(["proactive", "today"] as const).flatMap((surface) =>
    (["more_like_this", "too_much", "wrong_priority", "not_useful"] as const).map((kind) => ({
      targetKind: "proactive_card" as const,
      surface,
      kind,
      targetRef
    }))
  )
];
const unsafe: CreateUsefulnessFeedbackRequest[] = [
  { targetKind: "briefing_item", surface: "briefing", kind: "not_useful", targetRef },
  { targetKind: "briefing_item", surface: "today", kind: "not_useful", targetRef },
  ...(["chat_message", "briefing_item", "proactive_card"] as const).map((targetKind) => ({
    targetKind,
    surface: targetKind === "chat_message" ? ("chat" as const) : ("today" as const),
    kind: "remember_this" as const,
    targetRef
  })),
  { targetKind: "proactive_card", surface: "today", kind: "dismiss", targetRef },
  ...(["news_story", "sports_story"] as const).flatMap((targetKind) =>
    (["more_like_this", "less_like_this"] as const).map((kind) => ({
      targetKind,
      surface: "today" as const,
      kind,
      targetRef,
      ...(kind === "less_like_this" ? { reason: "Not my interests" } : {})
    }))
  )
];

function row(input: CreateFeedbackInput): UsefulnessFeedbackSignal {
  return {
    id: "feedback-1",
    owner_user_id: input.ownerUserId,
    target_kind: input.targetKind,
    target_ref: input.targetRef,
    surface: input.surface,
    kind: input.kind,
    source_kind: input.verification.sourceKind ?? null,
    source_label: input.verification.sourceLabel ?? null,
    priority_band: null,
    effect_kind: input.effectKind ?? null,
    effect_ref: input.effectRef ?? null,
    metadata_json: input.metadata,
    status: "active",
    reason_text: input.reasonText ?? null,
    rule_json: {},
    rule_version: null,
    revision: 1,
    created_at: new Date("2026-10-05T00:00:00Z"),
    updated_at: new Date("2026-10-05T00:00:00Z"),
    resolved_at: null
  };
}

function buildApp(verificationOwner: string | null = access.actorUserId) {
  const registry = new FeedbackTargetVerifierRegistry();
  const verify = vi.fn(
    async (
      _db: DataContextDb,
      input: Omit<FeedbackTargetVerification, "ownerUserId" | "canRemember"> & {
        actorUserId: string;
      }
    ) =>
      verificationOwner
        ? {
            ...input,
            ownerUserId: verificationOwner,
            metadata,
            canRemember: true,
            rememberExcerpt: "Remembered text"
          }
        : null
  );
  for (const target of [
    "chat_message",
    "briefing_run",
    "briefing_item",
    "proactive_card",
    "news_story",
    "sports_story"
  ] as const) {
    registry.register(target, verify);
  }
  const rows: UsefulnessFeedbackSignal[] = [];
  const findActive = vi.fn(
    async (_db: DataContextDb, owner: string, target: string, ref: string, kind: string) =>
      rows.find(
        (entry) =>
          entry.owner_user_id === owner &&
          entry.target_kind === target &&
          entry.target_ref === ref &&
          entry.kind === kind
      )
  );
  const create = vi.fn(async (_db: DataContextDb, input: CreateFeedbackInput) => {
    const created = row(input);
    rows.push(created);
    return created;
  });
  const repository = {
    findActive,
    create,
    findActiveStoryPreference: vi.fn(async () => undefined)
  } as unknown as UsefulnessFeedbackRepository;
  const archiveTask = vi.fn().mockResolvedValue(undefined);
  const deleteGoogleEvent = vi.fn().mockResolvedValue({ deleted: true });
  const cleanup = buildCalendarFollowThroughSideEffects({
    tasksRepository: {
      getById: vi.fn().mockResolvedValue({
        id: "task-1",
        source: "calendar",
        source_ref: `calendar:briefing-item:${targetRef}`
      }),
      update: archiveTask
    },
    calendarRepository: {
      getById: vi.fn().mockResolvedValue({
        id: "event-1",
        external_metadata: { jarvisCreated: true, followThroughTargetRef: targetRef }
      })
    },
    calendarWrite: { deleteEvent: deleteGoogleEvent }
  });
  const enqueueRefresh = vi.fn().mockResolvedValue("job-1");
  const effects = {
    removeCreatedRefs: vi.fn(cleanup.removeCreatedRefs),
    archiveTask,
    deleteGoogleEvent,
    createPendingManualCandidate: vi.fn().mockResolvedValue({ id: "candidate-1" }),
    cancelPendingManualCandidate: vi.fn().mockResolvedValue(true),
    applyDismiss: vi.fn().mockResolvedValue(undefined),
    undoDismissCard: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn(buildStoryPreferenceRefresh({ send: enqueueRefresh } as unknown as PgBoss)),
    enqueueRefresh,
    provider: vi.fn()
  };
  vi.stubGlobal("fetch", effects.provider);
  const withDataContext = vi.fn(
    async <T>(_ac: AccessContext, work: (db: DataContextDb) => Promise<T>) => work(scopedDb)
  );
  const app = Fastify();
  registerUsefulnessFeedbackRoutes(app, {
    resolveAccessContext: async () => access,
    dataContext: { withDataContext } as unknown as DataContextRunner,
    registry,
    repository,
    calendarFollowThroughSideEffects: { removeCreatedRefs: effects.removeCreatedRefs },
    manualMemoryCandidates: effects,
    cardSideEffects: effects,
    onStoryPreferenceChanged: effects.refresh
  });
  return { app, rows, create, findActive, verify, withDataContext, effects };
}

function expectNoEffects(effects: ReturnType<typeof buildApp>["effects"]): void {
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
}

afterEach(() => vi.unstubAllGlobals());

describe("record-only usefulness feedback signals", () => {
  it("advertises exactly the accepted target/action pairs in its request schema", async () => {
    const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
    app.post(
      "/signals-schema",
      { schema: { body: createUsefulnessFeedbackSignalRequestSchema } },
      async () => ({ ok: true })
    );
    try {
      for (const input of accepted) {
        expect(
          (await app.inject({ method: "POST", url: "/signals-schema", payload: input })).statusCode
        ).toBe(200);
      }
      for (const input of unsafe) {
        expect(
          (await app.inject({ method: "POST", url: "/signals-schema", payload: input })).statusCode
        ).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it.each(accepted)(
    "records only the owner signal for $targetKind $surface $kind",
    async (input) => {
      const { app, rows, create, findActive, verify, withDataContext, effects } = buildApp();
      try {
        const response = await app.inject({ method: "POST", url: signalPath, payload: input });
        expect(response.statusCode).toBe(201);
        expect(rows).toHaveLength(1);
        expect(withDataContext).toHaveBeenCalledWith(access, expect.any(Function));
        expect(findActive).toHaveBeenCalledWith(
          scopedDb,
          access.actorUserId,
          input.targetKind,
          targetRef,
          input.kind
        );
        expect(verify).toHaveBeenCalledWith(scopedDb, {
          actorUserId: access.actorUserId,
          targetKind: input.targetKind,
          targetRef,
          surface: input.surface
        });
        expect(create).toHaveBeenCalledWith(
          scopedDb,
          expect.objectContaining({
            ownerUserId: access.actorUserId,
            ...input,
            metadata: { calendarFollowThrough: metadata.calendarFollowThrough }
          })
        );
        expect(response.json().feedback).toMatchObject({
          ownerUserId: access.actorUserId,
          ...input,
          effectKind: null,
          effectRef: null,
          ruleVersion: null
        });
        expectNoEffects(effects);
        const repeated = await app.inject({ method: "POST", url: signalPath, payload: input });
        expect(repeated.statusCode).toBe(200);
        expect(create).toHaveBeenCalledTimes(1);
        expectNoEffects(effects);
      } finally {
        await app.close();
      }
    }
  );

  it.each(unsafe)("rejects effectful $targetKind $kind before dedup or write", async (input) => {
    const { app, rows, create, findActive, verify, withDataContext, effects } = buildApp();
    try {
      const response = await app.inject({ method: "POST", url: signalPath, payload: input });
      expect(response.statusCode).toBe(400);
      expect(rows).toEqual([]);
      expect(create).not.toHaveBeenCalled();
      expect(findActive).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(withDataContext).not.toHaveBeenCalled();
      expectNoEffects(effects);
    } finally {
      await app.close();
    }
  });

  it.each([null, "another-owner"])(
    "rejects unverified or cross-owner targets (%s)",
    async (owner) => {
      const { app, create, effects } = buildApp(owner);
      try {
        const response = await app.inject({
          method: "POST",
          url: signalPath,
          payload: accepted[0]
        });
        expect(response.statusCode).toBe(404);
        expect(create).not.toHaveBeenCalled();
        expectNoEffects(effects);
      } finally {
        await app.close();
      }
    }
  );

  it.each([
    { ...accepted[0], surface: "today" },
    { ...accepted[0], kind: "dismiss" },
    { ...accepted[0], suppressSideEffects: true },
    { ...accepted[0], ownerUserId: "another-owner" },
    { ...accepted[0], reason: "Extra field" }
  ])("rejects invalid pairs and client-controlled extras", async (input) => {
    const { app, create, effects } = buildApp();
    try {
      const response = await app.inject({ method: "POST", url: signalPath, payload: input });
      expect(response.statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();
      expectNoEffects(effects);
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      targetKind: "chat_message",
      surface: "chat",
      kind: "remember_this",
      effect: "createPendingManualCandidate"
    },
    { targetKind: "proactive_card", surface: "today", kind: "dismiss", effect: "applyDismiss" },
    { targetKind: "news_story", surface: "today", kind: "more_like_this", effect: "enqueueRefresh" }
  ] as const)(
    "keeps the real UI $kind action's $effect dependency active",
    async ({ effect, ...input }) => {
      const { app, effects } = buildApp();
      try {
        const response = await app.inject({
          method: "POST",
          url: uiPath,
          payload: { ...input, targetRef }
        });
        expect(response.statusCode).toBe(201);
        expect(effects[effect]).toHaveBeenCalledTimes(1);
        expect(effects.provider).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  );

  it("does not poison UI dedup: rejected not_useful still cleans up on a real UI request", async () => {
    const { app, create, effects } = buildApp();
    const input = unsafe[0]!;
    try {
      expect(
        (await app.inject({ method: "POST", url: signalPath, payload: input })).statusCode
      ).toBe(400);
      expect(create).not.toHaveBeenCalled();
      expectNoEffects(effects);
      const response = await app.inject({ method: "POST", url: uiPath, payload: input });
      expect(response.statusCode).toBe(201);
      expect(effects.removeCreatedRefs).toHaveBeenCalledWith(
        scopedDb,
        access.actorUserId,
        metadata
      );
      expect(effects.archiveTask).toHaveBeenCalledWith(scopedDb, "task-1", { status: "archived" });
      expect(effects.deleteGoogleEvent).toHaveBeenCalledWith(
        scopedDb,
        expect.objectContaining({ actorUserId: access.actorUserId }),
        { eventId: "event-1" }
      );
      expect(response.json().feedback.effectRef).toBe("task:task-1,calendar_event:event-1");
    } finally {
      await app.close();
    }
  });
});

const effectfulRoutes = [
  ["POST", uiPath],
  ["PATCH", `${uiPath}/:id`],
  ["POST", `${uiPath}/:id/undo`]
] as const;

describe("usefulness feedback chat boundary", () => {
  it.each(effectfulRoutes)("blocks original %s %s as external_effect", (method, path) => {
    const manifestRoute = usefulnessFeedbackModuleManifest.routes.find(
      (route) => route.method === method && route.path === path
    );
    expect(manifestRoute?.chat).toMatchObject({
      access: "blocked",
      blockedBecause: "external_effect"
    });
    // Independently protect the catalog if a future edit mislabels the manifest.
    const routes = usefulnessFeedbackModuleManifest.routes.map((route) => ({
      ...route,
      chat: { access: "write" as const, title: "Unsafe feedback" }
    }));
    const manifest = { ...usefulnessFeedbackModuleManifest, routes };
    const catalog = buildRouteCatalog([manifest], []);
    expect(catalog.resolve(method, path.replace(":id", "feedback-1"))?.route.policy).toMatchObject({
      access: "blocked",
      blockedBecause: "external_effect"
    });
    expect(() => assertRouteChatClassification([manifest])).toThrow(/external_effect/);
  });

  it("keeps static signals write/outside and GET read/outside without forced blocking", () => {
    const catalog = buildRouteCatalog([usefulnessFeedbackModuleManifest], []);
    expect(catalog.resolve("POST", signalPath)?.route.policy).toMatchObject({
      access: "write",
      content: "outside"
    });
    expect(catalog.resolve("GET", uiPath)?.route.policy).toMatchObject({
      access: "read",
      content: "outside"
    });
    expect(
      catalog.search("usefulness feedback", 20).some((route) => route.path === signalPath)
    ).toBe(true);
    expect(() => assertRouteChatClassification([usefulnessFeedbackModuleManifest])).not.toThrow();
  });
});
