import type { FastifyInstance } from "fastify";
import { handleRouteError } from "@moss/module-sdk";
import {
  meetingCapturePreferencesSchema,
  parseMeetingRememberedSource,
  type MeetingCapturePreferences
} from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";
import type { MeetingRecordRoutesDependencies } from "./routes.js";
import {
  readMeetingCapturePreferences,
  MEETING_CAPTURE_DEFAULT_KEY,
  MEETING_CAPTURE_SOURCE_KEY
} from "./capture-defaults.js";
export { MEETING_CAPTURE_DEFAULT_KEY, MEETING_CAPTURE_SOURCE_KEY } from "./capture-defaults.js";
export function registerMeetingPreferenceRoutes(
  server: FastifyInstance,
  dependencies: MeetingRecordRoutesDependencies
): void {
  const preferences = dependencies.preferences ?? new PreferencesRepository();
  server.get(
    "/api/meetings/preferences",
    { schema: { response: { 200: meetingCapturePreferencesSchema } } },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(actor, (db) =>
          readMeetingCapturePreferences(db, preferences)
        );
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
  server.put<{ Body: MeetingCapturePreferences }>(
    "/api/meetings/preferences",
    {
      schema: {
        body: meetingCapturePreferencesSchema,
        response: { 200: meetingCapturePreferencesSchema }
      }
    },
    async (request, reply) => {
      try {
        const actor = await dependencies.resolveAccessContext(request),
          defaultCaptureMode = request.body.defaultCaptureMode ?? "computer-audio";
        const rememberedSource = parseMeetingRememberedSource(request.body.rememberedSource);
        if (
          request.body.rememberedSource !== undefined &&
          request.body.rememberedSource !== null &&
          !rememberedSource
        )
          return reply.code(400).send({ code: "meeting_capture_invalid_input" });
        await dependencies.dataContext.withDataContext(actor, async (db) => {
          await preferences.upsert(db, MEETING_CAPTURE_DEFAULT_KEY, defaultCaptureMode);
          if (request.body.rememberedSource !== undefined)
            await preferences.upsert(db, MEETING_CAPTURE_SOURCE_KEY, rememberedSource);
        });
        return {
          defaultCaptureMode,
          ...(request.body.rememberedSource !== undefined ? { rememberedSource } : {})
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
