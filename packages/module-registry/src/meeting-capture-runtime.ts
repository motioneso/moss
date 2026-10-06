import {
  ConfiguredTranscriptionError,
  createConfiguredTranscription,
  type ActiveModulesResolver
} from "@moss/ai";
import type { DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";
import type { MeetingCaptureDependencies } from "@moss/meetings";

export type MeetingCaptureAuthorization = Pick<
  MeetingCaptureDependencies,
  | "resolveBrowser"
  | "resolveCompanion"
  | "resolveRecording"
  | "assertRecordingBinding"
  | "assertBinding"
  | "device"
  | "trustedOrigins"
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
    transcribe: transcription.transcribe,
    describeProcessingFailure(error) {
      if (!(error instanceof ConfiguredTranscriptionError)) return null;
      return {
        code:
          error.code === "unavailable" || error.code === "route-changed"
            ? "meeting_capture_processing_unavailable"
            : "meeting_capture_processing_failed",
        reason: error.reason,
        stage: error.stage,
        retryable: error.retryable,
        ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
        ...(typeof error.httpStatus === "number" &&
        Number.isInteger(error.httpStatus) &&
        error.httpStatus >= 100 &&
        error.httpStatus <= 599
          ? { httpStatus: error.httpStatus }
          : {})
      };
    }
  };
}
