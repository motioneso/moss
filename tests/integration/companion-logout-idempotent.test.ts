import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  registerCompanionRoutes,
  type CompanionRouteDeps
} from "../../apps/api/src/companion-routes.js";
import {
  bootstrap,
  context,
  runtime,
  linkFixture,
  setupLinkDatabase,
  closeLinkDatabase
} from "./meeting-link-fixture.js";

beforeAll(setupLinkDatabase);
afterAll(closeLinkDatabase);
const fixtures: Awaited<ReturnType<typeof linkFixture>>[] = [];
async function fixture() {
  const f = await linkFixture();
  // Only logout is invoked. Focus and queue handlers remain registered but unused.
  registerCompanionRoutes(f.server, {
    authRuntime: runtime,
    dataContext: context
  } as CompanionRouteDeps);
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.server.close()));
});

describe("canonical native logout with real auth services", () => {
  it("T2 returns 204 again when the first successful logout response was lost", async () => {
    const f = await fixture();
    const logout = () =>
      f.server.inject({ method: "POST", url: "/api/companion/logout", headers: f.native });
    expect((await logout()).statusCode).toBe(204);
    expect((await logout()).statusCode).toBe(204);
    await expect(
      runtime.companionDevices.resolve({ headers: f.native, requestId: "denied" })
    ).rejects.toMatchObject({ httpStatus: 401 });
  });
  it.each(["settings", "expired"] as const)(
    "T2 confirms absence for a %s device without granting an auth context",
    async (cause) => {
      const f = await fixture();
      if (cause === "settings")
        await runtime.meSessions.revokeOne({
          actorUserId: f.browser.actorUserId,
          sessionId: f.deviceId,
          headers: f.browserHeaders
        });
      else
        await bootstrap.query(
          "UPDATE app.companion_devices SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [f.deviceId]
        );
      expect(
        (await f.server.inject({ method: "POST", url: "/api/companion/logout", headers: f.native }))
          .statusCode
      ).toBe(204);
      expect(
        (await bootstrap.query("SELECT 1 FROM app.companion_devices WHERE id=$1", [f.deviceId]))
          .rows
      ).toEqual([]);
      await expect(
        runtime.companionDevices.resolve({ headers: f.native, requestId: "denied" })
      ).rejects.toMatchObject({ httpStatus: 401 });
    }
  );
  it("T2 random valid-form and malformed credentials cannot delete a different live Mac", async () => {
    const f = await fixture();
    const unknown = { authorization: `Bearer tm1_${"x".repeat(43)}` };
    expect(
      (await f.server.inject({ method: "POST", url: "/api/companion/logout", headers: unknown }))
        .statusCode
    ).toBe(204);
    for (const headers of [
      {},
      { authorization: "Bearer tm1_short" },
      { authorization: "Bearer mm1_wrong" },
      { ...f.native, cookie: "" }
    ]) {
      expect(
        (await f.server.inject({ method: "POST", url: "/api/companion/logout", headers }))
          .statusCode
      ).toBe(401);
    }
    await expect(
      runtime.companionDevices.resolve({ headers: f.native, requestId: "survives" })
    ).resolves.toHaveProperty("deviceId", f.deviceId);
  });
});
