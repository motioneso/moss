import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { AiRepository, AiSecretCipher } from "@moss/ai";
import type { DataContextRunner } from "@moss/db";
import { registerWorkshopProjectRoutes } from "@moss/workshop";

const GENERIC = "Workshop could not complete this request. Try again.";

function throwingDataContext(failure: Error): DataContextRunner {
  return {
    withDataContext: async () => {
      throw failure;
    }
  } as unknown as DataContextRunner;
}

describe("workshop unexpected-error handling", () => {
  it("keeps the browser response generic while writing the real cause to the server log", async () => {
    const logged: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logged.push(chunk.toString());
        callback();
      }
    });
    const app = Fastify({ logger: { level: "error", stream } });
    const failure = new Error("db is down: relation app.workshop_projects is missing");
    registerWorkshopProjectRoutes(app, {
      dataContext: throwingDataContext(failure),
      resolveAccessContext: async () => ({ actorUserId: "user-a" }),
      aiRepository: {
        selectModelForCapability: async () => undefined,
        selectProviderWithCredential: async () => undefined
      } as unknown as Pick<
        AiRepository,
        "selectModelForCapability" | "selectProviderWithCredential"
      >,
      cipher: {
        decryptJson: async () => {
          throw new Error("unused in this test");
        }
      } as unknown as Pick<AiSecretCipher, "decryptJson">
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/workshop/projects",
        payload: {
          requestKey: randomUUID(),
          title: "Saved project",
          initialRequest: "Keep my requirements",
          context: ""
        }
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: GENERIC });
      expect(response.body).not.toContain("db is down");
      expect(logged.join("\n")).toContain("workshop request failed");
      expect(logged.join("\n")).toContain("db is down");
    } finally {
      await app.close();
    }
  });
});
