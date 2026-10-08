import { describe, expect, it, vi } from "vitest";
import type { BriefingRun, DataContextDb } from "@moss/db";
import { createBriefingsFeedbackTargetVerifier } from "../../packages/briefings/src/feedback-verifier.js";
import { briefingSignalFeedbackItemId } from "../../packages/briefings/src/feedback-targets.js";
import { makeProactiveCardVerifier } from "../../packages/proactive-monitoring/src/target-verifier.js";
import type { ProactiveCardRow } from "../../packages/proactive-monitoring/src/types.js";

const db = {} as DataContextDb;
const run = {
  id: "run-id",
  owner_user_id: "owner",
  briefing_type: "morning",
  summary_text: "Complete briefing\n" + "Long content. ".repeat(200),
  source_metadata: {}
} as BriefingRun;
function build(
  target?: { source_label?: string; metadata_json?: Record<string, unknown> },
  source = run
) {
  const getOwnedRunById = vi.fn().mockResolvedValue(source);
  const findTarget = vi.fn().mockResolvedValue(target ?? null);
  return {
    getOwnedRunById,
    verify: createBriefingsFeedbackTargetVerifier({ getOwnedRunById }, { findTarget })
  };
}

describe("feedback approval targets from owning records", () => {
  it("shows a complete owned briefing and binds its exact text", async () => {
    const input = {
      actorUserId: "owner",
      targetKind: "briefing_run" as const,
      targetRef: run.id,
      surface: "briefing" as const
    };
    const first = await build().verify(db, input);
    expect(first?.approvalTarget?.label).toBe(run.summary_text);
    const changed = await build(undefined, { ...run, summary_text: "Changed" }).verify(db, input);
    expect(first?.approvalTarget?.version).not.toBe(changed?.approvalTarget?.version);
    expect(await build(undefined, { ...run, owner_user_id: "other" }).verify(db, input)).toBeNull();
  });
  it("resolves a signal through its stored run reference without trusting generic target labels", async () => {
    const summary = "Exact email signal " + "all words ".repeat(100);
    const ref = briefingSignalFeedbackItemId("email", "reply", summary);
    const { verify, getOwnedRunById } = build(
      { source_label: "Generic category", metadata_json: { briefingRunId: run.id } },
      { ...run, source_metadata: { emailSignals: [{ type: "reply", summary }] } }
    );
    const result = await verify(db, {
      actorUserId: "owner",
      targetKind: "briefing_item",
      targetRef: ref,
      surface: "briefing"
    });
    expect(result?.approvalTarget?.label).toBe(summary);
    expect(getOwnedRunById).toHaveBeenCalledWith(db, run.id);
  });
  it("resolves catch-up sender and full summary from its owned saved payload", async () => {
    const { verify } = build(
      { metadata_json: { briefingRunId: run.id } },
      {
        ...run,
        source_metadata: {
          structuredPayload: {
            catchUp: {
              entries: [{ id: "digest-ref", senderName: "Sender", summary: "Full summary" }]
            }
          }
        }
      }
    );
    const result = await verify(db, {
      actorUserId: "owner",
      targetKind: "briefing_item",
      targetRef: "digest-ref",
      surface: "briefing"
    });
    expect(result?.approvalTarget?.label).toBe("Sender\nFull summary");
  });
  it("does not manufacture an exact target for legacy, mismatched or foreign sources", async () => {
    const input = {
      actorUserId: "owner",
      targetKind: "briefing_item" as const,
      targetRef: "missing",
      surface: "briefing" as const
    };
    expect(
      (await build({ source_label: "Calendar", metadata_json: {} }).verify(db, input))
        ?.approvalTarget
    ).toBeUndefined();
    expect(
      (await build({ metadata_json: { briefingRunId: run.id } }).verify(db, input))?.approvalTarget
    ).toBeUndefined();
    expect(
      (
        await build(
          { metadata_json: { briefingRunId: run.id } },
          { ...run, owner_user_id: "other" }
        ).verify(db, input)
      )?.approvalTarget
    ).toBeUndefined();
  });
  it("never reuses the truncated remembering excerpt as a proactive approval target", async () => {
    const card = {
      id: "card-id",
      owner_user_id: "owner",
      title: "Exact title",
      summary: "Long proactive content ".repeat(50),
      source: "email",
      status: "active",
      source_ref_hash: "reference",
      priority_band: "normal"
    } as ProactiveCardRow;
    const verify = makeProactiveCardVerifier({ findById: vi.fn().mockResolvedValue(card) });
    const result = await verify(db, {
      actorUserId: "owner",
      targetKind: "proactive_card",
      targetRef: card.id,
      surface: "proactive"
    });
    expect(result?.approvalTarget?.label).toBe(`${card.title}\n${card.summary}`);
    expect(result?.canRemember).toBe(false);
    expect(result?.rememberExcerpt).toBeUndefined();
  });
});
