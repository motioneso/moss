import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccessContext, DataContextDb, DataContextRunner, PreferencesPort } from "@moss/db";

import { resolveTimezone } from "../../packages/notifications/src/repository.js";
import {
  interpretTaskSearchForRequest,
  type TaskSearchRouteDependencies
} from "../../packages/tasks/src/search-interpret-route.js";

/**
 * #3395. With no saved time zone, server-side "today" and quiet hours use the shared default
 * (Los Angeles), never UTC or the machine's zone. 03:30 UTC on Oct 10 is still Oct 9 in LA.
 */

const NOW = new Date("2026-10-10T03:30:00Z");
const ACCESS = { actorUserId: "11111111-1111-4111-8111-111111111111" } as AccessContext;

let previousTz: string | undefined;
beforeEach(() => {
  previousTz = process.env.TZ;
  process.env.TZ = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

describe("notification quiet hours zone", () => {
  it("uses the shared default zone when nothing is saved", async () => {
    const port = { getSettings: async () => null, getLocaleTimezone: async () => null };
    await expect(resolveTimezone(port, {} as DataContextDb, null)).resolves.toBe(
      "America/Los_Angeles"
    );
  });
});

describe("task search today", () => {
  async function promptFor(saved: unknown): Promise<string> {
    let prompt = "";
    const preferences = { get: async () => saved } as unknown as PreferencesPort;
    const dependencies: TaskSearchRouteDependencies = {
      resolveAccessContext: async () => ACCESS,
      dataContext: {
        withDataContext: async (_ctx: AccessContext, fn: (db: DataContextDb) => unknown) =>
          fn({} as DataContextDb)
      } as unknown as DataContextRunner,
      localePreferencesRepository: preferences,
      listsRepository: {
        list: async () => [],
        listTags: async () => []
      } as unknown as TaskSearchRouteDependencies["listsRepository"],
      aiRepository: {
        selectChatModelForUser: async () => ({
          provider_kind: "openai",
          provider_model_id: "test-model",
          provider_config_id: "provider-1"
        }),
        selectProviderWithCredential: async () => ({
          encrypted_credential: "sealed",
          base_url: null
        })
      } as unknown as TaskSearchRouteDependencies["aiRepository"],
      aiSecretCipher: {
        decryptJson: () => ({ apiKey: "test-key" })
      } as unknown as TaskSearchRouteDependencies["aiSecretCipher"],
      createChatAdapter: () =>
        ({
          generateChat: async (request: { messages: { content: string }[] }) => {
            prompt = request.messages[0]?.content ?? "";
            return { text: "{}" };
          }
        }) as unknown as ReturnType<NonNullable<TaskSearchRouteDependencies["createChatAdapter"]>>
    };
    await interpretTaskSearchForRequest(
      { body: { query: "due today" } } as FastifyRequest,
      dependencies
    ).catch(() => undefined);
    return prompt;
  }

  it("tells the AI today's date in the shared default zone when nothing is saved", async () => {
    expect(await promptFor(null)).toContain("Today in the user's locale: 2026-10-09.");
  });

  it("tells the AI today's date in the saved zone", async () => {
    const saved = { timezone: "Asia/Tokyo", region: "en-US", dateFormat: "24" };
    expect(await promptFor(saved)).toContain("Today in the user's locale: 2026-10-10.");
  });
});
