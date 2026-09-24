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

  it("deletes the owner's lapsed answers when it writes new ones", async () => {
    const lapsedKey = key(RULE_ONE, STORY_TWO, "e".repeat(64));
    const freshKey = key(RULE_TWO, STORY_ONE, "e".repeat(64));
    await asActor(ids.userA, (db) =>
      repository.writeStoryRelevanceAnswers(db, ids.userA, [
        { ...lapsedKey, answer: "yes", confidence: 0.9 }
      ])
    );
    // Age just that row, so it is expired but still physically present.
    await asActor(ids.userA, (db) =>
      db.db
        .updateTable("app.story_relevance_answer_cache")
        .set({ expires_at: new Date(0) })
        .where("owner_user_id", "=", ids.userA)
        .where("story_ref", "=", STORY_TWO)
        .where("model_fingerprint", "=", "e".repeat(64))
        .execute()
    );

    await asActor(ids.userA, (db) =>
      repository.writeStoryRelevanceAnswers(db, ids.userA, [
        { ...freshKey, answer: "no", confidence: 0.2 }
      ])
    );

    // The write swept the lapsed row; only the fresh one remains for this fingerprint.
    const survivors = await asActor(ids.userA, (db) =>
      db.db
        .selectFrom("app.story_relevance_answer_cache")
        .select(["story_ref", "rule_id"])
        .where("owner_user_id", "=", ids.userA)
        .where("model_fingerprint", "=", "e".repeat(64))
        .execute()
    );
    expect(survivors).toEqual([{ story_ref: STORY_ONE, rule_id: RULE_TWO }]);
  });

  it("refuses a write claiming another user's id and ignores a delete of their rule", async () => {
    // User B names user A as the owner. WITH CHECK must reject the row.
    await expect(
      asActor(ids.userB, (db) =>
        repository.writeStoryRelevanceAnswers(db, ids.userA, [
          { ...key(RULE_ONE, STORY_ONE, "g".repeat(64)), answer: "yes", confidence: 0.9 }
        ])
      )
    ).rejects.toThrow();

    const targetKey = key(RULE_TWO, STORY_ONE, "g".repeat(64));
    await asActor(ids.userA, (db) =>
      repository.writeStoryRelevanceAnswers(db, ids.userA, [
        { ...targetKey, answer: "no", confidence: 0.3 }
      ])
    );

    // User B deletes "user A's" rule. RLS hides those rows, so nothing is removed.
    await asActor(ids.userB, (db) =>
      repository.deleteStoryRelevanceAnswersForRule(db, ids.userA, RULE_TWO)
    );

    const survivors = await asActor(ids.userA, (db) =>
      repository.readStoryRelevanceAnswers(db, ids.userA, [targetKey])
    );
    // The read is by story and rule, so isolate this test's own fingerprint. A leaky delete would
    // have removed it along with the other rules the same owner holds for this story.
    const mine = survivors.filter((row) => row.modelFingerprint === "g".repeat(64));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.answer).toBe("no");
  });

  it("drops a rule's answers when the rule is edited, replaced or taken back", async () => {
    for (const transition of ["edit", "supersede", "undo"] as const) {
      const ruleId = await createLessLikeThisRule(`news:${transition}rule`);
      const ruleKey = key(ruleId, STORY_ONE, "h".repeat(64));
      await asActor(ids.userA, (db) =>
        repository.writeStoryRelevanceAnswers(db, ids.userA, [
          { ...ruleKey, answer: "yes", confidence: 0.9 }
        ])
      );

      if (transition === "edit") {
        await asActor(ids.userA, (db) =>
          repository.updateReason(db, ids.userA, ruleId, "a different reason", null)
        );
      } else if (transition === "supersede") {
        await asActor(ids.userA, (db) => repository.supersede(db, ids.userA, ruleId));
      } else {
        await asActor(ids.userA, (db) => repository.undo(db, ids.userA, ruleId));
      }

      const survivors = await asActor(ids.userA, (db) =>
        repository.readStoryRelevanceAnswers(db, ids.userA, [ruleKey])
      );
      expect(survivors).toEqual([]);
    }
  });
});

/** Creates an active "less like this" story rule the way the route would, and returns its id. */
async function createLessLikeThisRule(targetRef: string): Promise<string> {
  return asActor(ids.userA, async (db) => {
    const row = await repository.create(db, {
      ownerUserId: ids.userA,
      targetKind: "news_story",
      targetRef,
      surface: "news",
      kind: "less_like_this",
      verification: {
        ownerUserId: ids.userA,
        targetKind: "news_story",
        targetRef,
        surface: "news",
        canRemember: false
      },
      metadata: {},
      reasonText: "stop showing transfer gossip"
    });
    return row.id;
  });
}
