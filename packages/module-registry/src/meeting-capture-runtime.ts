import { createConfiguredTranscription, type ActiveModulesResolver } from "@moss/ai";
import type { DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type { MeetingCaptureDependencies } from "@moss/meetings";

export type MeetingCaptureAuthorization = Pick<
  MeetingCaptureDependencies,
  "resolveBrowser" | "resolveCompanion" | "assertBinding" | "device" | "trustedOrigins"
>;

/** Auth proves device/session identity; Meetings owns its own narrowly approved grant. */
export function createMeetingCaptureRuntime(deps: {
  readonly dataContext: DataContextRunner;
  readonly resolveActiveModules: ActiveModulesResolver;
  readonly meetingCaptureAuthorization?: MeetingCaptureAuthorization;
}): MeetingCaptureDependencies {
  const transcription = createConfiguredTranscription({ dataContext: deps.dataContext });
  const unavailable = async (): Promise<never> => {
    throw new HttpError(503, "Meeting recorder authorization unavailable");
  };
  const authorization = deps.meetingCaptureAuthorization ?? {
    resolveBrowser: unavailable,
    resolveCompanion: unavailable,
    assertBinding: unavailable,
    device: unavailable,
    trustedOrigins: []
  };
  return {
    ...authorization,
    dataContext: deps.dataContext,
    async assertModuleAvailable(actor) {
      const modules = await deps.resolveActiveModules(actor.actorUserId);
      if (!modules.some((module) => module.id === "meetings"))
        throw new HttpError(404, "Meetings unavailable");
    },
    processingAvailability: transcription.availability,
    transcribe: transcription.transcribe
  };
}
