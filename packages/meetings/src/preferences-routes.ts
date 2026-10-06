import type { FastifyInstance } from "fastify";
import { handleRouteError } from "@moss/module-sdk";
import {
  meetingCapturePreferencesSchema,
  parseMeetingCaptureMode,
  parseMeetingRememberedSource,
  type MeetingCapturePreferences
} from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";
import type { MeetingRecordRoutesDependencies } from "./routes.js";
export const MEETING_CAPTURE_DEFAULT_KEY = "meetings.capture.default-mode";
export const MEETING_CAPTURE_SOURCE_KEY = "meetings.capture.remembered-source";
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
        return await dependencies.dataContext.withDataContext(actor, async (db) => {
          const [mode, source] = await Promise.all([
            preferences.get(db, MEETING_CAPTURE_DEFAULT_KEY),
            preferences.get(db, MEETING_CAPTURE_SOURCE_KEY)
          ]);
          const rememberedSource = parseMeetingRememberedSource(source);
          return {
            defaultCaptureMode: parseMeetingCaptureMode(mode),
            ...(rememberedSource ? { rememberedSource } : {})
          };
        });
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
          defaultCaptureMode = request.body.defaultCaptureMode;
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
