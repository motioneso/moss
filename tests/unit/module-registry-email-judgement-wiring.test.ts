import { describe, expect, it, vi } from "vitest";

import type { GenerateStructuredInput, GenerateStructuredResult } from "@moss/ai";
import type { ToolExecute } from "@moss/module-sdk";

import {
  buildEmailContextProviders,
  buildEmailJudgementGenerate,
  buildKnownSenderAddresses,
  buildUserAddressesFor
} from "../../packages/module-registry/src/email-judgement-wiring.js";

const aiRepository = {} as never;
const cipher = {} as never;

function generateWith(result: GenerateStructuredResult) {
  return vi.fn(async (_db: unknown, _input: GenerateStructuredInput, _deps: unknown) => result);
}

describe("buildEmailJudgementGenerate (#2274 Task 10)", () => {
  it("asks the reasoning tier under the email judgement service key with the prompt", async () => {
    const generateStructured = generateWith({
      ok: true,
      object: { owed: false },
      usage: { inputTokens: 1, outputTokens: 1 }
    });
    const cliAdapter = vi.fn();
    const generate = buildEmailJudgementGenerate({
      aiRepository,
      cipher,
      generateStructured,
      createCliStructuredAdapter: cliAdapter as never
    });
    const scopedDb = { tag: "db" };
    const answer = await generate(scopedDb, "user-1", "judge this thread");
    expect(answer).toEqual({ owed: false });
    expect(generateStructured).toHaveBeenCalledTimes(1);
    const [db, input, deps] = generateStructured.mock.calls[0]!;
    expect(db).toBe(scopedDb);
    expect(input.service).toBe("module.commitments.email-judgement");
    expect(input.tierHint).toBe("reasoning");
    expect(input.requireExplicitBinding).toBe(false);
    expect(input.prompt).toBe("judge this thread");
    expect(input.schema).toEqual(expect.objectContaining({ type: "object" }));
    expect(deps).toEqual(
      expect.objectContaining({
        repository: aiRepository,
        cipher,
        createCliStructuredAdapter: cliAdapter
      })
    );
  });

  it("throws with the error code when the model call does not succeed", async () => {
    const generate = buildEmailJudgementGenerate({
      aiRepository,
      cipher,
      generateStructured: generateWith({ ok: false, error: "needs_config" })
    });
    await expect(generate({}, "user-1", "p")).rejects.toThrow("needs_config");
  });
});

describe("buildEmailContextProviders", () => {
  const calls: Record<string, unknown[]> = {};
  const tool =
    (name: string, data: Record<string, unknown>): ToolExecute =>
    async (_db, input, ctx) => {
      calls[name] = [input, ctx];
      return { data };
    };
  const manifests = [
    {
      id: "notes",
      assistantTools: [
        {
          name: "notes.search",
          execute: tool("notes.search", {
            chunks: [
              { sourcePath: "a.md", lineStart: 1, lineEnd: 2, text: "first line\nsecond line" },
              { sourcePath: "b.md", lineStart: 3, lineEnd: 3, text: "  spaced  " }
            ]
          })
        }
      ]
    },
    {
      id: "tasks",
      assistantTools: [
        {
          name: "tasks.list",
          execute: tool("tasks.list", {
            items: [
              {
                id: "t1",
                title: "Send numbers",
                dueAt: "2026-09-10T17:00:00.000Z",
                status: "todo"
              },
              { id: "t2", title: "No due date", dueAt: null, status: "todo" }
            ]
          })
        }
      ]
    },
    {
      id: "calendar",
      assistantTools: [
        {
          name: "calendar.listVisibleEvents",
          execute: tool("calendar.listVisibleEvents", {
            events: [
              {
                title: "Standup",
                startsAt: "2026-09-05T16:00:00.000Z",
                endsAt: "2026-09-05T16:30:00.000Z",
                location: "secret room"
              }
            ]
          })
        }
      ]
    }
  ] as never;
  const person = {
    id: "p1",
    displayName: "Sarah Kim",
    relationshipSummary: "Landlord",
    contextSummary: "Long summary"
  };
  const providers = buildEmailContextProviders({
    manifests,
    people: { resolve: vi.fn(async () => person) },
    timezoneFor: async () => "America/Los_Angeles",
    now: () => new Date("2026-09-04T12:00:00.000Z")
  });

  it("people: maps a resolved person to the compact context shape", async () => {
    const got = await providers.people!.resolveByEmail({}, "u1", "sarah@kim.example");
    expect(got).toEqual({
      personId: "p1",
      displayName: "Sarah Kim",
      relationshipSummary: "Landlord",
      recentNoteLines: []
    });
  });

  it("notes: runs the search tool as the owner and returns trimmed one-line excerpts", async () => {
    const lines = await providers.notes!.searchLines({}, "u1", "lease", 5);
    expect(lines).toEqual(["first line second line", "spaced"]);
    expect(calls["notes.search"]![0]).toEqual({ query: "lease", limit: 5 });
    expect(calls["notes.search"]![1]).toEqual(
      expect.objectContaining({ actorUserId: "u1", chatSessionId: "" })
    );
  });

  it("tasks: lists open tasks with title and local due date only", async () => {
    const tasks = await providers.tasks!.listOpen({}, "u1", 25);
    expect(tasks).toEqual([
      { id: "t1", title: "Send numbers", dueLocalDate: "2026-09-10" },
      { id: "t2", title: "No due date", dueLocalDate: null }
    ]);
    expect(calls["tasks.list"]![0]).toEqual({ status: "todo" });
  });

  it("calendar: asks for the window from now and keeps only title and times", async () => {
    const win = await providers.calendar!.windowFromNow({}, "u1", 14);
    expect(win).toEqual({
      busy: [
        { start: "2026-09-05T16:00:00.000Z", end: "2026-09-05T16:30:00.000Z", title: "Standup" }
      ],
      timezone: "America/Los_Angeles"
    });
    expect(calls["calendar.listVisibleEvents"]![0]).toEqual({
      startsAfter: "2026-09-04T12:00:00.000Z",
      startsBefore: "2026-09-18T12:00:00.000Z",
      limit: 20
    });
  });

  it("leaves a provider out when its tool is not registered", () => {
    const none = buildEmailContextProviders({
      manifests: [] as never,
      people: { resolve: vi.fn(async () => null) },
      timezoneFor: async () => "UTC"
    });
    expect(none.notes).toBeUndefined();
    expect(none.tasks).toBeUndefined();
    expect(none.calendar).toBeUndefined();
    expect(none.people).toBeDefined();
  });
});

describe("address sets", () => {
  it("user addresses are the cache's frequent recipients, bare and lower-cased", async () => {
    const userAddressesFor = buildUserAddressesFor({
      email: {
        listFrequentRecipientAddresses: vi.fn(async () => ["Ben <Ben@Ben.com>", "ben@work.example"])
      }
    });
    const mine = await userAddressesFor({}, "u1");
    expect([...mine].sort()).toEqual(["ben@ben.com", "ben@work.example"]);
  });

  it("known senders are people identities plus whoever the user has written to", async () => {
    const knownSenderAddresses = buildKnownSenderAddresses({
      people: { listEmailIdentityValues: vi.fn(async () => ["sarah@kim.example"]) },
      email: {
        listRecipientAddressesOfSenders: vi.fn(async (_db, _owner, senders: ReadonlySet<string>) =>
          senders.has("ben@ben.com") ? ["Tom <Tom@Example.com>"] : []
        )
      },
      userAddressesFor: async () => new Set(["ben@ben.com"])
    });
    const known = await knownSenderAddresses({}, "u1");
    expect([...known].sort()).toEqual(["sarah@kim.example", "tom@example.com"]);
  });
});
