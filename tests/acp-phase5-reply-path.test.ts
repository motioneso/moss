import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { dataContextBrand } from "@moss/db";

import {
  attemptAcpProjectReply,
  buildAcpPrompt,
  workshopSessionKey,
  ACP_BUILD_GUIDANCE_TEXT
} from "../packages/workshop/src/acp-reply.js";
import {
  attemptProjectReply,
  PROJECT_REPLY_PERSONA_TEXT
} from "../packages/workshop/src/project-reply.js";
import { WorkshopProjectFeed } from "../packages/workshop/src/project-feed.js";

const PROJECT = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Reading tracker",
  initialRequest: "Track the books I read.",
  context: "",
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z"
};

const USER_ENTRY = {
  projectId: PROJECT.id,
  messageId: "22222222-2222-4222-8222-222222222222",
  sequence: "2",
  kind: "user_message" as const,
  text: "Add a build step.",
  delivery: "pending" as const,
  createdAt: "2026-09-07T00:01:00.000Z"
};

const ACCESS = { actorUserId: "actor-1", requestId: "req-1" };

function dataContextWithSetting(value: unknown) {
  const scopedDb = {
    [dataContextBrand]: true as const,
    db: {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: async () => (value === undefined ? undefined : { value: { value } })
          })
        })
      })
    }
  };
  return {
    withDataContext: async (_access: unknown, fn: (db: unknown) => Promise<never>) => fn(scopedDb)
  };
}

function entry(text: string, kind: "user_message" | "assistant_message" = "user_message") {
  return {
    projectId: PROJECT.id,
    messageId: `33333333-3333-4333-8333-33333333333${kind === "user_message" ? "1" : "2"}`,
    sequence: "1",
    kind,
    text,
    delivery: "delivered" as const,
    createdAt: "2026-09-07T00:00:30.000Z"
  };
}

describe("workshopSessionKey", () => {
  it("matches the run-command tool's project parser", () => {
    expect(workshopSessionKey("actor-1", PROJECT.id)).toBe(`workshop:actor-1:${PROJECT.id}`);
  });
});

describe("buildAcpPrompt", () => {
  it("carries persona, guidance, project, replayed history, and the message", () => {
    const prompt = buildAcpPrompt(PROJECT, USER_ENTRY, [
      entry("First idea."),
      entry("Started the module.", "assistant_message")
    ]);
    expect(prompt).toContain(PROJECT_REPLY_PERSONA_TEXT);
    expect(prompt).toContain(ACP_BUILD_GUIDANCE_TEXT);
    expect(prompt).toContain("Track the books I read.");
    expect(prompt).toContain("Owner: First idea.");
    expect(prompt).toContain("Moss: Started the module.");
    expect(prompt.endsWith(USER_ENTRY.text)).toBe(true);
  });

  it("omits the history section when there is nothing to replay", () => {
    const prompt = buildAcpPrompt(PROJECT, USER_ENTRY, []);
    expect(prompt).not.toContain("Earlier in this project:");
    expect(prompt.endsWith(USER_ENTRY.text)).toBe(true);
  });

  it("keeps total guidance under 150 words", () => {
    const words = `${PROJECT_REPLY_PERSONA_TEXT} ${ACP_BUILD_GUIDANCE_TEXT}`
      .split(/\s+/)
      .filter(Boolean);
    expect(words.length).toBeLessThan(150);
  });
});

describe("attemptProjectReply agent branch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const oldPathDeps = (setting: unknown) => ({
    dataContext: dataContextWithSetting(setting),
    aiRepository: {
      selectModelForCapability: async () => null,
      selectProviderWithCredential: async () => null
    },
    cipher: { decryptJson: () => ({}) }
  });

  it("stays on today's path when the setting is default", async () => {
    const opener = { open: vi.fn() };
    const result = await attemptProjectReply(
      { ...oldPathDeps("default"), openWorkshopAcpSession: opener } as never,
      ACCESS,
      PROJECT,
      USER_ENTRY
    );
    expect(result).toEqual({ delivered: false });
    expect(opener.open).not.toHaveBeenCalled();
  });

  it("delivers false without throwing when the outside agent is selected but unwired", async () => {
    const result = await attemptProjectReply(
      oldPathDeps("claude-code-acp") as never,
      ACCESS,
      PROJECT,
      USER_ENTRY
    );
    expect(result).toEqual({ delivered: false });
  });

  it("answers through the opener and stores the reply the same way", async () => {
    const prompt = vi.fn(async (_text: string) => "Built and passing.");
    const close = vi.fn(async () => undefined);
    const opener = { open: vi.fn(async () => ({ prompt, close })) };
    const list = vi
      .spyOn(WorkshopProjectFeed.prototype, "list")
      .mockResolvedValue({ entries: [entry("First idea.")], nextCursor: "1" });
    const assistantEntry = { ...entry("Built and passing.", "assistant_message") };
    const append = vi
      .spyOn(WorkshopProjectFeed.prototype, "appendAssistantReply")
      .mockResolvedValue({ entry: assistantEntry });

    const result = await attemptAcpProjectReply(
      { dataContext: dataContextWithSetting("claude-code-acp"), opener } as never,
      ACCESS,
      PROJECT,
      USER_ENTRY
    );

    expect(result).toEqual({ delivered: true, assistantEntry });
    expect(opener.open).toHaveBeenCalledWith({
      sessionKey: `workshop:actor-1:${PROJECT.id}`,
      projectId: PROJECT.id,
      actorUserId: "actor-1"
    });
    const sentPrompt = prompt.mock.calls.at(0)?.at(0);
    expect(typeof sentPrompt).toBe("string");
    expect(sentPrompt).toContain("Owner: First idea.");
    expect(sentPrompt?.endsWith(USER_ENTRY.text)).toBe(true);
    expect(append).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
    expect(list).toHaveBeenCalled();
  });

  it("still delivers when closing the turn fails", async () => {
    const opener = {
      open: vi.fn(async () => ({
        prompt: async () => "Built.",
        close: async () => {
          throw new Error("runner gone");
        }
      }))
    };
    vi.spyOn(WorkshopProjectFeed.prototype, "list").mockResolvedValue({
      entries: [],
      nextCursor: "0"
    });
    const assistantEntry = { ...entry("Built.", "assistant_message") };
    vi.spyOn(WorkshopProjectFeed.prototype, "appendAssistantReply").mockResolvedValue({
      entry: assistantEntry
    });

    const result = await attemptAcpProjectReply(
      { dataContext: dataContextWithSetting("claude-code-acp"), opener } as never,
      ACCESS,
      PROJECT,
      USER_ENTRY
    );
    expect(result).toEqual({ delivered: true, assistantEntry });
  });
});
