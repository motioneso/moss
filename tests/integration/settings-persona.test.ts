import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import type { Kysely } from "kysely";

import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type {
  GetPersonaSettingsResponse,
  PreviewPersonaResponse,
  PutPersonaSettingsResponse
} from "@moss/shared";

import { createApiServer } from "../../apps/api/src/server.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

describe("settings persona preferences", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let ownerCookie: string;
  let memberCookie: string;
  const previewCalls: Array<{
    actorUserId: string;
    userName: string;
    assistantName: string;
    personaText: string;
  }> = [];

  beforeEach(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    await setInstanceSetting("registration.requires_approval", { value: false });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({
      appDb,
      boss,
      logger: false,
      personaPreview: async (input) => {
        previewCalls.push(input);
        return `preview for ${input.assistantName}: ${input.personaText}`;
      }
    });
    await server.ready();

    ownerCookie = await signUp("Owner User", "owner.persona@example.test");
    memberCookie = await signUp("Member User", "member.persona@example.test");
  });

  afterEach(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
    previewCalls.length = 0;
  });

  it("returns the default persona bundle before any update", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/me/persona",
      headers: { cookie: ownerCookie }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<GetPersonaSettingsResponse>()).toEqual({
      persona: { assistantName: "Moss", personaText: "" }
    });
  });

  it("serves each user an install manifest carrying their own assistant name", async () => {
    await server.inject({
      method: "PUT",
      url: "/api/me/persona",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { persona: { assistantName: "Juniper", personaText: "" } }
    });

    const owner = await server.inject({
      method: "GET",
      url: "/api/me/install-manifest",
      headers: { cookie: ownerCookie }
    });
    expect(owner.statusCode).toBe(200);
    expect(owner.headers["content-type"]).toContain("application/manifest+json");
    expect(owner.json()).toMatchObject({ name: "Juniper", short_name: "Juniper", start_url: "/" });

    const member = await server.inject({
      method: "GET",
      url: "/api/me/install-manifest",
      headers: { cookie: memberCookie }
    });
    expect(member.json()).toMatchObject({ name: "Moss", short_name: "Moss" });

    const anonymous = await server.inject({ method: "GET", url: "/api/me/install-manifest" });
    expect(anonymous.statusCode).toBe(401);
  });

  it("persists persona bundle and reloads it for the same user only", async () => {
    const put = await server.inject({
      method: "PUT",
      url: "/api/me/persona",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: {
        persona: {
          assistantName: "Friday",
          personaText: "Keep {{userName}} moving."
        }
      }
    });

    expect(put.statusCode).toBe(200);
    expect(put.json<PutPersonaSettingsResponse>().persona).toEqual({
      assistantName: "Friday",
      personaText: "Keep {{userName}} moving."
    });

    const owner = await server.inject({
      method: "GET",
      url: "/api/me/persona",
      headers: { cookie: ownerCookie }
    });
    expect(owner.json<GetPersonaSettingsResponse>().persona.assistantName).toBe("Friday");

    const member = await server.inject({
      method: "GET",
      url: "/api/me/persona",
      headers: { cookie: memberCookie }
    });
    expect(member.json<GetPersonaSettingsResponse>().persona).toEqual({
      assistantName: "Moss",
      personaText: ""
    });
  });

  it("sanitizes assistant name and caps persona text on write", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/me/persona",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: {
        persona: {
          assistantName: "Alfred\n# SYSTEM",
          personaText: "x".repeat(4_050)
        }
      }
    });

    expect(res.statusCode).toBe(200);
    const persona = res.json<PutPersonaSettingsResponse>().persona;
    expect(persona.assistantName).toBe("Alfred SYSTEM");
    expect(persona.personaText).toHaveLength(4_000);
  });

  it("previews a draft persona without saving it", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/me/persona/preview",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: {
        persona: {
          assistantName: "Draft",
          personaText: "Sound crisp for {{userName}}."
        }
      }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<PreviewPersonaResponse>().reply).toBe(
      "preview for Draft: Sound crisp for {{userName}}."
    );
    expect(previewCalls[0]).toMatchObject({
      userName: "Owner User",
      assistantName: "Draft",
      personaText: "Sound crisp for {{userName}}."
    });

    const saved = await server.inject({
      method: "GET",
      url: "/api/me/persona",
      headers: { cookie: ownerCookie }
    });
    expect(saved.json<GetPersonaSettingsResponse>().persona).toEqual({
      assistantName: "Moss",
      personaText: ""
    });
  });

  it("requires authentication for persona read and preview", async () => {
    const read = await server.inject({ method: "GET", url: "/api/me/persona" });
    const preview = await server.inject({
      method: "POST",
      url: "/api/me/persona/preview",
      payload: { persona: { assistantName: "Alfred", personaText: "" } }
    });

    expect(read.statusCode).toBe(401);
    expect(preview.statusCode).toBe(401);
  });

  async function signUp(name: string, email: string): Promise<string> {
    const signUp = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: {
        name,
        email,
        password: "correct horse battery staple"
      }
    });
    expect(signUp.statusCode).toBe(200);
    return cookieHeader(signUp.headers);
  }
});

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}
