import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import {
  FeedbackTargetVerifierRegistry,
  registerUsefulnessFeedbackRoutes
} from "../../packages/usefulness-feedback/src/index.js";
import type { UsefulnessFeedbackRepository } from "../../packages/usefulness-feedback/src/repository.js";

const access: AccessContext = {
  actorUserId: "00000000-0000-4000-8000-000000000001",
  requestId: "req-feedback"
};

function buildApp(args: {
  verifierResult: Record<string, unknown> | null;
  removeResult?: string | null;
}) {
  const registry = new FeedbackTargetVerifierRegistry();
  registry.register("briefing_item", async () =>
    args.verifierResult
      ? {
          ownerUserId: access.actorUserId,
          targetKind: "briefing_item",
          targetRef: "calendar:prep:1",
          surface: "briefing",
          sourceKind: "calendar",
          sourceLabel: "Calendar",
          metadata: args.verifierResult,
          canRemember: false
        }
      : null
  );
  const calls: Record<string, unknown>[] = [];
  const repository = {
    findActive: async () => undefined,
    create: async (_db: DataContextDb, input: Record<string, unknown>) => ({
      id: "feedback-1",
      owner_user_id: access.actorUserId,
      target_kind: input.targetKind,
      target_ref: input.targetRef,
      surface: input.surface,
      kind: input.kind,
      source_kind: "calendar",
      source_label: "Calendar",
      priority_band: null,
      effect_kind: input.effectKind ?? null,
      effect_ref: input.effectRef ?? null,
      metadata_json: input.metadata,
      status: "active",
      reason_text: input.reasonText ?? null,
      rule_json: null,
      rule_version: null,
      revision: 1,
      created_at: new Date("2026-07-04T00:00:00.000Z"),
      updated_at: new Date("2026-07-04T00:00:00.000Z"),
      resolved_at: null
    })
  } as unknown as UsefulnessFeedbackRepository;
  const app = Fastify();
  registerUsefulnessFeedbackRoutes(app, {
    resolveAccessContext: async () => access,
    dataContext: {
      withDataContext: async <T>(_ac: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    } as unknown as DataContextRunner,
    registry,
    repository,
    calendarFollowThroughSideEffects: {
      removeCreatedRefs: async (_db, _actorUserId, metadata) => {
        calls.push(metadata);
        return args.removeResult === undefined ? "task:task-1" : args.removeResult;
      }
    }
  });
  return { app, calls };
}

describe("usefulness feedback Calendar follow-through side effects", () => {
  it("runs not_useful side effects from verified persisted metadata", async () => {
    const metadata = {
      calendarFollowThrough: { targetRef: "calendar:prep:1", taskId: "task-1" }
    };
    const { app, calls } = buildApp({ verifierResult: metadata });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/me/usefulness-feedback",
      payload: {
        targetKind: "briefing_item",
        targetRef: "calendar:prep:1",
        surface: "briefing",
        kind: "not_useful"
      }
    });

    expect(res.statusCode).toBe(201);
    expect(calls).toEqual([metadata]);
    expect(res.json().feedback).toMatchObject({
      effectKind: "calendar_follow_through_removed",
      effectRef: "task:task-1"
    });
    await app.close();
  });

  it("does not run side effects when target verification fails", async () => {
    const { app, calls } = buildApp({ verifierResult: null });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/me/usefulness-feedback",
      payload: {
        targetKind: "briefing_item",
        targetRef: "calendar:prep:1",
        surface: "briefing",
        kind: "not_useful"
      }
    });

    expect(res.statusCode).toBe(404);
    expect(calls).toEqual([]);
    await app.close();
  });

  it("records feedback without an effect when removal returns null", async () => {
    const { app } = buildApp({
      verifierResult: { calendarFollowThrough: { targetRef: "calendar:prep:1" } },
      removeResult: null
    });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/me/usefulness-feedback",
      payload: {
        targetKind: "briefing_item",
        targetRef: "calendar:prep:1",
        surface: "briefing",
        kind: "not_useful"
      }
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().feedback.effectKind).toBeNull();
    expect(res.json().feedback.effectRef).toBeNull();
    await app.close();
  });
});
