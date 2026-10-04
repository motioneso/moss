import type { FastifyInstance } from "fastify";
import { handleRouteError } from "@moss/module-sdk";
import {
  meetingCapturePreferencesSchema,
  parseMeetingCaptureMode,
  type MeetingCapturePreferences
} from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";
import type { MeetingRecordRoutesDependencies } from "./routes.js";

export const MEETING_CAPTURE_DEFAULT_KEY = "meetings.capture.default-mode";

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
        const value = await dependencies.dataContext.withDataContext(actor, (db) =>
          preferences.get(db, MEETING_CAPTURE_DEFAULT_KEY)
        );
        return { defaultCaptureMode: parseMeetingCaptureMode(value) };
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
        const actor = await dependencies.resolveAccessContext(request);
        const value = request.body.defaultCaptureMode;
        await dependencies.dataContext.withDataContext(actor, (db) =>
          preferences.upsert(db, MEETING_CAPTURE_DEFAULT_KEY, value)
        );
        return { defaultCaptureMode: value };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
