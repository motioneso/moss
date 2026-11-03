import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { GetChatSettingsResponse } from "@moss/shared";

import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

describe("chat settings", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let ownerCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    await setInstanceSetting("registration.requires_approval", { value: false });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();

    ownerCookie = await signUp("Owner", "owner.chat-settings@example.test");
    memberCookie = await signUp("Member", "member.chat-settings@example.test");
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("returns balanced defaults before any update", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/chat/settings",
      headers: { cookie: ownerCookie }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<GetChatSettingsResponse>()).toEqual({
      chat: { responseStyle: "balanced", frontDoorGuardedDevices: false }
    });
  });

  it("persists response style per user", async () => {
    const put = await server.inject({
      method: "PUT",
      url: "/api/chat/settings",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { chat: { responseStyle: "concise" } }
    });

    expect(put.statusCode).toBe(200);

    const owner = await server.inject({
      method: "GET",
      url: "/api/chat/settings",
      headers: { cookie: ownerCookie }
    });
    expect(owner.json<GetChatSettingsResponse>().chat.responseStyle).toBe("concise");

    const member = await server.inject({
      method: "GET",
      url: "/api/chat/settings",
      headers: { cookie: memberCookie }
    });
    expect(member.json<GetChatSettingsResponse>().chat.responseStyle).toBe("balanced");
  });

  it("keeps the locks-and-doors switch private to its owner and across style saves", async () => {
    const put = (cookie: string, chat: object) =>
      server.inject({
        method: "PUT",
        url: "/api/chat/settings",
        headers: { cookie, "content-type": "application/json" },
        payload: { chat }
      });
    const read = async (cookie: string) =>
      (
        await server.inject({
          method: "GET",
          url: "/api/chat/settings",
          headers: { cookie }
        })
      ).json<GetChatSettingsResponse>().chat;

    // The owner is the first account, so an admin. Their value must not reach the member.
    expect(
      (await put(ownerCookie, { responseStyle: "balanced", frontDoorGuardedDevices: true }))
        .statusCode
    ).toBe(200);
    expect((await read(ownerCookie)).frontDoorGuardedDevices).toBe(true);
    expect((await read(memberCookie)).frontDoorGuardedDevices).toBe(false);

    // A save that leaves the field out keeps the stored value.
    expect((await put(ownerCookie, { responseStyle: "detailed" })).statusCode).toBe(200);
    expect(await read(ownerCookie)).toEqual({
      responseStyle: "detailed",
      frontDoorGuardedDevices: true
    });

    // The member's own save never touches the owner's value.
    expect((await put(memberCookie, { responseStyle: "concise" })).statusCode).toBe(200);
    expect((await read(ownerCookie)).frontDoorGuardedDevices).toBe(true);
    expect((await read(memberCookie)).frontDoorGuardedDevices).toBe(false);
  });

  it("rejects unsupported response styles", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/chat/settings",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { chat: { responseStyle: "verbose" } }
    });

    expect(res.statusCode).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await server.inject({ method: "GET", url: "/api/chat/settings" });
    expect(res.statusCode).toBe(401);
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
