import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccessContext, DataContextDb } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import {
  registerMeetingPreferenceRoutes,
  MEETING_CAPTURE_DEFAULT_KEY
} from "../../packages/meetings/src/preferences-routes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup(stored: unknown = null, authError?: Error) {
  const app = Fastify();
  apps.push(app);
  const scoped = {} as DataContextDb;
  const actors: AccessContext[] = [];
  const preferences = {
    get: vi.fn(async (_db: DataContextDb, _key: string) => stored),
    upsert: vi.fn(async () => undefined)
  };
  registerMeetingPreferenceRoutes(app, {
    resolveAccessContext: async () => {
      if (authError) throw authError;
      return { actorUserId: "owner", requestId: "preferences" };
    },
    dataContext: {
      withDataContext: async <T>(actor: AccessContext, work: (db: DataContextDb) => Promise<T>) => {
        actors.push(actor);
        return work(scoped);
      }
    },
    preferences
  });
  return { app, scoped, preferences, actors };
}
describe("meeting capture defaults", () => {
  it.each([null, undefined, "unknown-mode", { mode: "computer-audio" }])(
    "uses microphone and system audio for absent or invalid stored mode %s",
    async (value) => {
      const { app, preferences } = setup(value);
      expect((await app.inject("/api/meetings/preferences")).json()).toEqual({
        defaultCaptureMode: "computer-audio"
      });
      expect(preferences.upsert).not.toHaveBeenCalled();
    }
  );
  it.each(["microphone-only", "selected-app", "computer-audio"])(
    "reads explicit %s without modifying it",
    async (mode) => {
      const { app, preferences, scoped } = setup(mode);
      expect((await app.inject("/api/meetings/preferences")).json()).toEqual({
        defaultCaptureMode: mode
      });
      expect(preferences.get).toHaveBeenCalledTimes(2);
      expect(preferences.get).toHaveBeenCalledWith(scoped, MEETING_CAPTURE_DEFAULT_KEY);
      expect(preferences.get).toHaveBeenCalledWith(scoped, "meetings.capture.remembered-source");
    }
  );
  it.each([null, "microphone-only", "selected-app", "computer-audio"])(
    "saves only the explicit chosen mode %s",
    async (defaultCaptureMode) => {
      const { app, preferences, scoped, actors } = setup();
      const response = await app.inject({
        method: "PUT",
        url: "/api/meetings/preferences",
        payload: { defaultCaptureMode, ownerUserId: "other" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        defaultCaptureMode: defaultCaptureMode ?? "computer-audio"
      });
      expect(preferences.upsert).toHaveBeenCalledExactlyOnceWith(
        scoped,
        MEETING_CAPTURE_DEFAULT_KEY,
        defaultCaptureMode ?? "computer-audio"
      );
      expect(actors).toEqual([{ actorUserId: "owner", requestId: "preferences" }]);
    }
  );
  it.each(["all", "", {}, [], false, 0])(
    "rejects unsupported mode %s",
    async (defaultCaptureMode) => {
      const { app, preferences } = setup();
      const response = await app.inject({
        method: "PUT",
        url: "/api/meetings/preferences",
        payload: { defaultCaptureMode }
      });
      expect(response.statusCode).toBe(400);
      expect(preferences.upsert).not.toHaveBeenCalled();
    }
  );
  it.each(["GET", "PUT"] as const)("requires authentication for %s", async (method) => {
    const { app, preferences, actors } = setup(null, new HttpError(401, "Authentication required"));
    const response = await app.inject({
      method,
      url: "/api/meetings/preferences",
      payload: method === "PUT" ? { defaultCaptureMode: "microphone-only" } : undefined
    });
    expect(response.statusCode).toBe(401);
    expect(actors).toEqual([]);
    expect(preferences.get).not.toHaveBeenCalled();
    expect(preferences.upsert).not.toHaveBeenCalled();
  });
});

describe("remembered exact meeting source", () => {
  it("retains an exact legacy source and its mode when no separate mode is saved", async () => {
    const { app, preferences } = setup();
    const rememberedSource = {
      deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      microphoneId: "mic-uid",
      mode: "selected-app",
      applicationId: "com.example.meet"
    };
    preferences.get.mockImplementation(async (_db, key) =>
      key === "meetings.capture.remembered-source" ? rememberedSource : null
    );
    expect((await app.inject("/api/meetings/preferences")).json()).toEqual({
      defaultCaptureMode: "selected-app",
      rememberedSource
    });
    expect(preferences.upsert).not.toHaveBeenCalled();
  });
  it("stores only explicit stable source identity and can clear it", async () => {
    const { app, preferences } = setup();
    const rememberedSource = {
      deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      microphoneId: "mic-uid",
      mode: "selected-app",
      applicationId: "com.example.meet"
    };
    const saved = await app.inject({
      method: "PUT",
      url: "/api/meetings/preferences",
      payload: { defaultCaptureMode: "selected-app", rememberedSource }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().rememberedSource).toEqual(rememberedSource);
    expect(preferences.upsert).toHaveBeenCalledWith(
      expect.anything(),
      "meetings.capture.remembered-source",
      rememberedSource
    );
    const cleared = await app.inject({
      method: "PUT",
      url: "/api/meetings/preferences",
      payload: { defaultCaptureMode: null, rememberedSource: null }
    });
    expect(cleared.json().rememberedSource).toBeNull();
  });
  it("does not partially save a mode if a selected-app preference lacks stable identity", async () => {
    const { app, preferences } = setup();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/meetings/preferences",
          payload: {
            defaultCaptureMode: "selected-app",
            rememberedSource: {
              deviceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              microphoneId: "mic",
              mode: "selected-app"
            }
          }
        })
      ).statusCode
    ).toBe(400);
    expect(preferences.upsert).not.toHaveBeenCalled();
  });
});
