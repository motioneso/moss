// tests/integration/news-chat-tools-write-tools.test.ts
//
// News Slice 4 Task 8 (#975) — the four remaining write tools
// (removeSource/addTopic/removeTopic/addExclusion). All confirm-gated by
// default (write risk, news_personalization family defaults to
// ask_each_time), all mirroring their REST route's write path exactly.
//
// Split out of tests/integration/news-chat-tools.test.ts, which covers Task 7
// (previewSource/confirmSource/refreshNews/diagnostics) and shares setup with
// this file via tests/integration/news-chat-tools-harness.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DataContextRunner } from "@moss/db";
import {
  NEWS_MAX_CUSTOM_TOPICS,
  NewsPersonalizationRepository
} from "../../packages/news/src/personalization-repository.js";

import { ids } from "./test-database.js";
import { NewsChatToolsHarness, parseToolText } from "./news-chat-tools-harness.js";

describe("topic/exclusion/removal write tools (#975 Task 8)", () => {
  const harness = new NewsChatToolsHarness();

  beforeAll(async () => harness.setup(), 60_000);
  afterAll(async () => harness.teardown());

    const repository = new NewsPersonalizationRepository();

    async function topicRowCount(ownerUserId: string): Promise<number> {
      const rows = await harness.bootstrap.query(
        `SELECT count(*)::int AS n FROM app.news_custom_topics WHERE owner_user_id = $1`,
        [ownerUserId]
      );
      return rows.rows[0].n as number;
    }

    async function exclusionRows(ownerUserId: string): Promise<Array<{ domain: string }>> {
      const rows = await harness.bootstrap.query(
        `SELECT canonical_domain AS domain FROM app.news_source_exclusions WHERE owner_user_id = $1`,
        [ownerUserId]
      );
      return rows.rows as Array<{ domain: string }>;
    }

    async function ownerSourceRows(ownerUserId: string): Promise<Array<{ id: string }>> {
      const rows = await harness.bootstrap.query(
        `SELECT id FROM app.news_custom_sources WHERE owner_user_id = $1`,
        [ownerUserId]
      );
      return rows.rows as Array<{ id: string }>;
    }

    it("addTopic is confirm-gated: no row while pending, then row + confirmed audit", async () => {
      const { gateway, emitted, mint } = harness.makeGateway();
      const token = mint(ids.userA, "news-chat-add-topic");
      const before = await topicRowCount(ids.userA);

      const pending = gateway.callTool(token, "news.addTopic", {
        label: "Local climate policy",
        guidance: "prefer municipal coverage"
      });
      const request = await harness.waitForActionRequest(emitted, 0);
      expect(request.toolName).toBe("news.addTopic");
      // Confirmation card text comes from tool INPUT only (execute hasn't run).
      expect(request.summary).toContain("Local climate policy");
      expect(await topicRowCount(ids.userA)).toBe(before);

      await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
      const result = await pending;
      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).not.toContain("fingerprint");
      const payload = parseToolText(result);
      expect(payload.error).toBeUndefined();
      expect(payload.topic).toMatchObject({ label: "Local climate policy" });

      expect(await topicRowCount(ids.userA)).toBe(before + 1);
      expect(await harness.waitForAudit({ toolName: "news.addTopic", outcome: "success" })).toMatchObject({
        owner_user_id: ids.userA,
        approval_mode: "confirmed"
      });

      // Regression: `guidance` was dropped from the tool schema, but the gateway validator does
      // not strip undeclared keys (input-validation.ts), so the input above still carried
      // guidance: "prefer municipal coverage" as if the model had emitted it anyway. Assert the
      // execute fn — not the schema — is what refuses it: the persisted row must be null.
      const rows = await harness.bootstrap.query(
        `SELECT guidance FROM app.news_custom_topics WHERE owner_user_id = $1 AND label = $2`,
        [ids.userA, "Local climate policy"]
      );
      expect(rows.rows[0].guidance).toBeNull();
    }, 30_000);

    it("addTopic at the per-user cap returns a friendly error and writes nothing", async () => {
      const runner = new DataContextRunner(harness.appDb);
      await runner.withDataContext(
        { actorUserId: ids.userB, requestId: "seed-topic-limit" },
        async (db) => {
          const existing = await topicRowCount(ids.userB);
          for (let i = existing; i < NEWS_MAX_CUSTOM_TOPICS; i += 1) {
            await repository.createCustomTopic(db, {
              label: `Seeded topic ${i}`,
              guidance: null,
              validationFingerprint: "opaque-test-fingerprint"
            });
          }
        }
      );

      const { gateway, emitted, mint } = harness.makeGateway();
      const token = mint(ids.userB, "news-chat-topic-limit");
      const pending = gateway.callTool(token, "news.addTopic", { label: "One too many" });
      const request = await harness.waitForActionRequest(emitted, 0);
      await gateway.resolveActionRequest(ids.userB, request.actionRequestId, "confirmed");
      const result = await pending;

      // Benign failure: friendly data error, not a sanitized tool failure.
      expect(result).toMatchObject({ ok: true });
      expect(JSON.stringify(result)).toMatch(/limit|at most/i);
      expect(JSON.stringify(result)).not.toContain("Tool news.addTopic failed");
      expect(await topicRowCount(ids.userB)).toBe(NEWS_MAX_CUSTOM_TOPICS);
    }, 30_000);

    it("removeTopic is confirm-gated and deletes the topic only after confirm", async () => {
      const runner = new DataContextRunner(harness.appDb);
      const seeded = await runner.withDataContext(
        { actorUserId: ids.userA, requestId: "seed-remove-topic" },
        (db) =>
          repository.createCustomTopic(db, {
            label: "Doomed topic",
            guidance: null,
            validationFingerprint: "opaque-test-fingerprint"
          })
      );
      const before = await topicRowCount(ids.userA);

      const { gateway, emitted, mint } = harness.makeGateway();
      const token = mint(ids.userA, "news-chat-remove-topic");
      const pending = gateway.callTool(token, "news.removeTopic", { topicId: seeded.id });
      const request = await harness.waitForActionRequest(emitted, 0);
      expect(await topicRowCount(ids.userA)).toBe(before);

      await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
      const result = await pending;
      expect(result).toMatchObject({ ok: true });
      expect(parseToolText(result)).toMatchObject({ removed: true });
      expect(await topicRowCount(ids.userA)).toBe(before - 1);
      expect(
        await harness.waitForAudit({ toolName: "news.removeTopic", outcome: "success" })
      ).toMatchObject({ owner_user_id: ids.userA, approval_mode: "confirmed" });
    }, 30_000);

    it("addExclusion is confirm-gated and stores the normalized domain", async () => {
      const { gateway, emitted, mint } = harness.makeGateway();
      const token = mint(ids.userA, "news-chat-add-exclusion");

      // Mixed-case input proves the tool routes through normalizePublisherDomain.
      const pending = gateway.callTool(token, "news.addExclusion", {
        domain: "Blocked.Example.Com"
      });
      const request = await harness.waitForActionRequest(emitted, 0);
      expect(await exclusionRows(ids.userA)).toHaveLength(0);

      await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "confirmed");
      const result = await pending;
      expect(result).toMatchObject({ ok: true });
      expect(parseToolText(result)).toMatchObject({
        exclusion: { domain: "blocked.example.com" }
      });
      expect(await exclusionRows(ids.userA)).toEqual([{ domain: "blocked.example.com" }]);
      expect(
        await harness.waitForAudit({ toolName: "news.addExclusion", outcome: "success" })
      ).toMatchObject({ owner_user_id: ids.userA, approval_mode: "confirmed" });
    }, 30_000);

    it("removeSource treats a cross-owner id as not-found and removes own sources after confirm", async () => {
      // B follows example.com through the existing chat preview/confirm flow.
      const { gateway, emitted, mint } = harness.makeGateway();
      const tokenB = mint(ids.userB, "news-chat-b-source");
      const preview = await harness.previewExampleFeed(gateway, tokenB);
      const candidate = preview.candidates[0]!;
      let mark = emitted.length;
      const confirmPending = gateway.callTool(tokenB, "news.confirmSource", {
        confirmationId: preview.confirmationId,
        candidateId: candidate.candidateId,
        label: candidate.label,
        domain: candidate.domain
      });
      const confirmRequest = await harness.waitForActionRequest(emitted, mark);
      await gateway.resolveActionRequest(ids.userB, confirmRequest.actionRequestId, "confirmed");
      await confirmPending;
      const bSources = await ownerSourceRows(ids.userB);
      expect(bSources).toHaveLength(1);
      const targetId = bSources[0]!.id;

      // Cross-owner attempt: A confirms removal of B's source id — RLS makes it
      // invisible, so the tool reports not-found and B's row is untouched.
      const tokenA = mint(ids.userA, "news-chat-a-remove-foreign");
      mark = emitted.length;
      const stealPending = gateway.callTool(tokenA, "news.removeSource", { sourceId: targetId });
      const stealRequest = await harness.waitForActionRequest(emitted, mark);
      await gateway.resolveActionRequest(ids.userA, stealRequest.actionRequestId, "confirmed");
      const stealResult = await stealPending;
      expect(stealResult).toMatchObject({ ok: true });
      expect(JSON.stringify(stealResult)).toMatch(/not found/i);
      expect(await ownerSourceRows(ids.userB)).toHaveLength(1);

      // Positive control: the owner removes it, confirm-gated end to end.
      mark = emitted.length;
      const removePending = gateway.callTool(tokenB, "news.removeSource", { sourceId: targetId });
      const removeRequest = await harness.waitForActionRequest(emitted, mark);
      expect(await ownerSourceRows(ids.userB)).toHaveLength(1);
      await gateway.resolveActionRequest(ids.userB, removeRequest.actionRequestId, "confirmed");
      const removeResult = await removePending;
      expect(removeResult).toMatchObject({ ok: true });
      expect(parseToolText(removeResult)).toMatchObject({ removed: true });
      expect(await ownerSourceRows(ids.userB)).toHaveLength(0);
      expect(
        await harness.waitForAudit({
          toolName: "news.removeSource",
          outcome: "success",
          ownerUserId: ids.userB
        })
      ).toMatchObject({ owner_user_id: ids.userB, approval_mode: "confirmed" });
    }, 30_000);
});
