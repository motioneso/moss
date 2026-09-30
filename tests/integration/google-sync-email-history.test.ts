import { describe, expect, it } from "vitest";
import { GoogleApiError } from "@moss/connectors";
import {
  EmailRepository,
  handles,
  ids,
  runGoogleSync,
  seedGoogleAccount
} from "./helpers/google-sync-orchestration.js";

// #2804 fix 4: the backlog walk asks Gmail only for mail that changed, and saves its mailbox
// position only after a walk that ended with no email errors.
describe("google sync backlog walk by change history (#2804)", () => {
  const NOW = new Date("2026-09-30T12:00:00.000Z");
  const RECENT = String(new Date("2026-09-20T12:00:00.000Z").getTime());
  const TOO_OLD = String(new Date("2026-07-01T12:00:00.000Z").getTime());

  const message = (id: string, historyId: string, internalDate = RECENT) => ({
    id,
    threadId: `${id}-thread`,
    historyId,
    internalDate,
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "Subject", value: `Status ${id}` },
        { name: "From", value: "a@b.example" }
      ],
      body: { data: Buffer.from("A short status update for the week.").toString("base64") }
    }
  });

  const junkReply = () => ({
    text: JSON.stringify({ gate: "nothing", category: "noise", confidence: 0.9 })
  });

  interface Calls {
    backlogLists: number;
    historyStarts: string[];
    fetched: string[];
    modelCalls: number;
  }

  interface FakeOptions {
    backlogIds?: string[];
    history?: () => Promise<{ messageIds: string[]; nextPageToken?: string }>;
    getMessage?: (id: string) => Promise<ReturnType<typeof message>>;
    anchor?: string;
  }

  const setup = async (requestId: string) => {
    const accountId = await seedGoogleAccount(handles.dataContext, [
      "https://www.googleapis.com/auth/gmail.modify"
    ]);
    const ctx = { actorUserId: ids.userA, requestId };
    const position = () =>
      handles.dataContext.withDataContext(ctx, async (db) => {
        const row = await db.db
          .selectFrom("app.connector_accounts")
          .select("email_history_id")
          .where("id", "=", accountId)
          .executeTakeFirstOrThrow();
        return row.email_history_id;
      });
    const setPosition = (value: string | null) =>
      handles.workerDataContext.withDataContext(ctx, (db) =>
        db.db
          .updateTable("app.connector_accounts")
          .set({ email_history_id: value })
          .where("id", "=", accountId)
          .execute()
      );
    const run = async (options: FakeOptions): Promise<Calls> => {
      const calls: Calls = { backlogLists: 0, historyStarts: [], fetched: [], modelCalls: 0 };
      await handles.workerDataContext.withDataContext(ctx, (db) =>
        runGoogleSync(db, {
          getFreshAccessToken: async () => "tok",
          getActiveAccount: async () => ({ id: accountId, scopes: ["gmail"] }),
          googleClient: {
            listCalendarEvents: async () => [],
            listMessageIds: async () => [],
            listMessageIdsPage: async ({ query }: { query?: string }) => {
              if (!query?.includes("older_than:1d")) return { messages: [] };
              calls.backlogLists += 1;
              return { messages: (options.backlogIds ?? []).map((id) => ({ id })) };
            },
            getProfileHistoryId: async () => options.anchor ?? "500",
            listHistoryPage: async ({ startHistoryId }: { startHistoryId: string }) => {
              calls.historyStarts.push(startHistoryId);
              if (!options.history) throw new Error("history not expected");
              return options.history();
            },
            getMessage: async ({ id }: { id: string }) => {
              calls.fetched.push(id);
              return options.getMessage ? options.getMessage(id) : message(id, `H-${id}`);
            }
          },
          emailExtractDeps: {
            runChat: async () => {
              calls.modelCalls += 1;
              return junkReply();
            }
          },
          now: () => NOW
        })
      );
      return calls;
    };
    // The seeded account can be shared across tests, so start each one with no position.
    await setPosition(null);
    return { accountId, ctx, position, setPosition, run };
  };

  it("lists the whole window on the first walk and saves the position it captured", async () => {
    const t = await setup("pgboss:hist-first");
    const calls = await t.run({ backlogIds: ["first-1"], anchor: "500" });
    expect(calls.backlogLists).toBeGreaterThan(0);
    expect(calls.fetched).toEqual(["first-1"]);
    expect(await t.position()).toBe("500");
  });

  it("fetches only changed mail once a position is saved, and moves the position forward", async () => {
    const t = await setup("pgboss:hist-changed");
    await t.setPosition("500");
    const calls = await t.run({
      backlogIds: ["must-not-be-listed"],
      anchor: "600",
      history: async () => ({ messageIds: ["changed-1"] })
    });
    expect(calls.backlogLists).toBe(0);
    expect(calls.historyStarts).toEqual(["500"]);
    expect(calls.fetched).toEqual(["changed-1"]);
    expect(await t.position()).toBe("600");
  });

  it("does not send an unchanged message named by history to the model again", async () => {
    const t = await setup("pgboss:hist-unchanged");
    await t.run({ backlogIds: ["same-1"], anchor: "500" });
    const before = await t.run({ backlogIds: ["same-1"], anchor: "500" });
    expect(before.modelCalls).toBe(0);
    const calls = await t.run({
      anchor: "600",
      history: async () => ({ messageIds: ["same-1"] })
    });
    expect(calls.fetched).toEqual(["same-1"]);
    expect(calls.modelCalls).toBe(0);
  });

  it("leaves mail older than the window alone when history names it", async () => {
    const t = await setup("pgboss:hist-old");
    await t.setPosition("500");
    await t.run({
      anchor: "600",
      history: async () => ({ messageIds: ["old-1"] }),
      getMessage: async (id) => message(id, `H-${id}`, TOO_OLD)
    });
    const rows = await handles.dataContext.withDataContext(t.ctx, (db) =>
      db.db
        .selectFrom("app.email_messages")
        .select("external_id")
        .where("connector_account_id", "=", t.accountId)
        .where("external_id", "=", "old-1")
        .execute()
    );
    expect(rows).toHaveLength(0);
  });

  it("skips a message that was deleted before it could be fetched", async () => {
    const t = await setup("pgboss:hist-deleted");
    await t.setPosition("500");
    await t.run({
      anchor: "600",
      history: async () => ({ messageIds: ["gone-1"] }),
      getMessage: async () => {
        throw new GoogleApiError("not found", 404, "notFound", "gmail.messages.get");
      }
    });
    expect(await t.position()).toBe("600");
  });

  // Condition 4 from the coordinator: any history error must fall back to the full walk.
  it.each([
    [
      "an expired position (404)",
      () => new GoogleApiError("gone", 404, "notFound", "gmail.history.list")
    ],
    [
      "a quota refusal (403)",
      () => new GoogleApiError("no", 403, "rateLimitExceeded", "gmail.history.list")
    ],
    ["an unexpected failure", () => new Error("socket hang up")]
  ])("falls back to the full walk on %s and saves a fresh position", async (_name, makeError) => {
    const t = await setup(`pgboss:hist-fallback-${_name.length}`);
    await t.setPosition("100");
    const calls = await t.run({
      backlogIds: ["fallback-1"],
      anchor: "700",
      history: async () => {
        throw makeError();
      }
    });
    // A rate-limit refusal is retried before the walk gives up on history.
    expect(new Set(calls.historyStarts)).toEqual(new Set(["100"]));
    expect(calls.backlogLists).toBeGreaterThan(0);
    expect(calls.fetched).toEqual(["fallback-1"]);
    expect(await t.position()).toBe("700");
  });

  it("keeps the old position when the walk ends with an email error", async () => {
    const t = await setup("pgboss:hist-error");
    await t.setPosition("500");
    await t.run({
      anchor: "600",
      history: async () => ({ messageIds: ["bad-1"] }),
      getMessage: async () => {
        throw new GoogleApiError("refused", 403, "forbidden", "gmail.messages.get");
      }
    });
    expect(await t.position()).toBe("500");
  });

  it("does not save a position after a failed full walk either", async () => {
    const t = await setup("pgboss:hist-full-error");
    await t.run({
      backlogIds: ["bad-full-1"],
      anchor: "600",
      getMessage: async () => {
        throw new GoogleApiError("refused", 403, "forbidden", "gmail.messages.get");
      }
    });
    expect(await t.position()).toBeNull();
  });

  it("stamps the judgement request and clears the stamp when a new revision is saved", async () => {
    const t = await setup("pgboss:hist-marker");
    const repo = new EmailRepository();
    const base = {
      connectorAccountId: t.accountId,
      externalId: "marker-1",
      sender: "a@b.example",
      subject: "Marker",
      receivedAt: new Date("2026-09-20T12:00:00.000Z"),
      summary: null,
      signals: { pendingJudgement: true }
    };
    const stamped = await handles.workerDataContext.withDataContext(t.ctx, async (db) => {
      await repo.upsertCachedMessage(db, { ...base, externalMetadata: { historyId: "A" } });
      await repo.markJudgementRequested(db, t.accountId, ["marker-1"], NOW);
      return (await repo.listSyncMarkers(db, t.accountId)).find((m) => m.externalId === "marker-1");
    });
    expect(stamped?.judgementRequestedAt?.toISOString()).toBe(NOW.toISOString());
    const after = await handles.workerDataContext.withDataContext(t.ctx, async (db) => {
      await repo.upsertCachedMessage(db, { ...base, externalMetadata: { historyId: "B" } });
      return (await repo.listSyncMarkers(db, t.accountId)).find((m) => m.externalId === "marker-1");
    });
    expect(after?.judgementRequestedAt).toBeNull();
  });
});
