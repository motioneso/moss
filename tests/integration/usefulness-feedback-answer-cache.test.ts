import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createDatabase, DataContextRunner, type DataContextDb, type MossDatabase } from "@moss/db";
import { type StoryRelevanceAnswerKey } from "../../packages/usefulness-feedback/src/relevance/answer-cache.js";
import { UsefulnessFeedbackRepository } from "../../packages/usefulness-feedback/src/repository.js";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

/**
 * #2636: the remembered sorting answers against the real database. The store is owner-only under
 * row level security, so one user's answers must be invisible to another even when the caller
 * hands over the other user's id.
 */

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
const repository = new UsefulnessFeedbackRepository();

const RULE_ONE = "11111111-1111-4111-8111-111111111111";
const RULE_TWO = "22222222-2222-4222-8222-222222222222";
const STORY_ONE = "news:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STORY_TWO = "news:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function key(
  ruleId: string,
  storyRef = STORY_ONE,
  fingerprint = "f".repeat(64)
): StoryRelevanceAnswerKey {
  return {
    storyRef,
    ruleId,
    ruleTextHash: "1".repeat(64),
    modelFingerprint: fingerprint
  };
}

function asActor<T>(actorUserId: string, run: (scopedDb: DataContextDb) => Promise<T>): Promise<T> {
  return dataContext.withDataContext({ actorUserId, requestId: "req:answer-cache" }, run);
}

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("story relevance answer cache (#2636)", () => {
  it("keeps one user's remembered answers out of another user's reach", async () => {
    const userAKey = key(RULE_ONE);
    await asActor(ids.userA, (db) =>
      repository.writeStoryRelevanceAnswers(db, ids.userA, [
        { ...userAKey, answer: "yes", confidence: 0.9 }
      ])
    );
    await asActor(ids.userB, (db) =>
      repository.writeStoryRelevanceAnswers(db, ids.userB, [
        { ...userAKey, answer: "no", confidence: 0.2 }
      ])
    );

    const aReads = await asActor(ids.userA, (db) =>
      repository.readStoryRelevanceAnswers(db, ids.userA, [userAKey])
    );
    expect(aReads).toHaveLength(1);
    expect(aReads[0]?.answer).toBe("yes");

    const bReadsOwn = await asActor(ids.userB, (db) =>
      repository.readStoryRelevanceAnswers(db, ids.userB, [userAKey])
    );
    expect(bReadsOwn).toHaveLength(1);
    expect(bReadsOwn[0]?.answer).toBe("no");

    // User B asks for user A's rows expressly. Row level security must still return nothing.
    const bReadsAsA = await asActor(ids.userB, (db) =>
      repository.readStoryRelevanceAnswers(db, ids.userA, [userAKey])
    );
    expect(bReadsAsA).toEqual([]);
  });

  it("does not read an expired answer", async () => {
    const expiredKey = key(RULE_ONE, STORY_TWO);
    await asActor(ids.userA, (db) =>
      repository.writeStoryRelevanceAnswers(db, ids.userA, [
        { ...expiredKey, answer: "yes", confidence: 0.9 }
      ])
    );
    await asActor(ids.userA, (db) =>
      db.db
        .updateTable("app.story_relevance_answer_cache")
        .set({ expires_at: new Date(0) })
        .where("owner_user_id", "=", ids.userA)
        .where("rule_id", "=", RULE_ONE)
        .execute()
    );

    const reads = await asActor(ids.userA, (db) =>
      repository.readStoryRelevanceAnswers(db, ids.userA, [expiredKey])
    );
    expect(reads).toEqual([]);
  });

  it("drops only one rule's answers when that rule is deleted", async () => {
    const deleteFirstKey = key(RULE_ONE, STORY_ONE, "d".repeat(64));
    const deleteSecondKey = key(RULE_TWO, STORY_ONE, "d".repeat(64));
    await asActor(ids.userA, (db) =>
      repository.writeStoryRelevanceAnswers(db, ids.userA, [
        { ...deleteFirstKey, answer: "yes", confidence: 0.9 },
        { ...deleteSecondKey, answer: "no", confidence: 0.1 }
      ])
    );

    await asActor(ids.userA, (db) =>
      repository.deleteStoryRelevanceAnswersForRule(db, ids.userA, RULE_ONE)
    );

    const remaining = await asActor(ids.userA, (db) =>
      repository.readStoryRelevanceAnswers(db, ids.userA, [deleteFirstKey, deleteSecondKey])
    );
    expect(remaining.map((row) => row.ruleId)).toEqual([RULE_TWO]);
  });
});
