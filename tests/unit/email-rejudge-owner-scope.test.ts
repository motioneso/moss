import { describe, expect, it } from "vitest";
import { EmailRepository } from "../../packages/email/src/repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

/**
 * #2271 round 2. The re-judge reset empties the stored verdict so the next sync judges the mail
 * again. The database rule for updating email lets an actor change rows another person shared with
 * them at manage level, so the reset has to name the owner itself: without that, re-judging for one
 * person wipes saved results on someone else's shared mail, and only the first person's mailbox
 * ever syncs them back.
 *
 * This pins the owner predicate at the SQL level, with no database involved. The end-to-end proof
 * that a second owner's shared mail survives is in
 * tests/integration/email-rejudge-owner-scope.test.ts.
 */

describe("EmailRepository.clearRecentTriage", () => {
  it("clears only the actor's own mail, and only the two analysis columns", async () => {
    const { scoped, queries } = makeRecordingDb();
    const since = new Date("2026-08-21T00:00:00.000Z");

    await new EmailRepository().clearRecentTriage(scoped, since);

    expect(queries).toHaveLength(1);
    const statement = queries[0]!.sql;
    expect(statement).toContain('update "app"."email_messages"');
    expect(statement).toContain('"owner_user_id" = app.current_actor_user_id()');
    expect(statement).toContain('"received_at" >=');
    // Only the stored analysis is emptied; nothing about the message itself is rewritten.
    expect(statement).toContain('set "summary" =');
    expect(statement).toContain('"signals" =');
    expect(statement).not.toContain('"sender"');
    expect(statement).not.toContain('"subject"');
    expect(statement).not.toContain('"body_excerpt"');
    expect(queries[0]!.parameters).toContain(since);
  });
});
