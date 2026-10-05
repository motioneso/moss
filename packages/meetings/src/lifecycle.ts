import type {
  MeetingAudioEnvelope,
  MeetingCaptureEpoch,
  MeetingCaptureSelection,
  MeetingProcessingCapabilities,
  MeetingReadiness,
  MeetingSourceBoundary
} from "@moss/shared";

export interface MeetingLifecycle {
  readonly meetingId: string;
  readonly status: "draft" | "ready" | "recording" | "paused" | "stopping" | "processing";
  readonly selection: MeetingCaptureSelection | null;
  readonly processing: MeetingProcessingCapabilities | null;
  readonly epochs: readonly MeetingCaptureEpoch[];
  readonly lastTransitionMs: number;
  readonly stop: { readonly cutoffMs: number; readonly deadlineMs: number } | null;
  readonly retainedAudioPermitted: boolean;
  readonly finalizationOutcome: "drained" | "deadline-expired" | null;
}

export type MeetingLifecycleCommand =
  | {
      readonly type: "ready";
      readonly atMs: number;
      readonly selection: MeetingCaptureSelection;
      readonly readiness: MeetingReadiness;
      readonly processing: MeetingProcessingCapabilities;
    }
  | { readonly type: "start"; readonly atMs: number; readonly readiness: MeetingReadiness }
  | {
      readonly type: "pause";
      readonly atMs: number;
      readonly boundaries: readonly MeetingSourceBoundary[];
    }
  | {
      readonly type: "resume";
      readonly atMs: number;
      readonly selection: MeetingCaptureSelection;
      readonly readiness: MeetingReadiness;
      readonly permitRetainedAudio: boolean;
    }
  | {
      readonly type: "stop";
      readonly atMs: number;
      readonly boundaries: readonly MeetingSourceBoundary[];
      readonly finalizationMs: number;
    }
  | { readonly type: "finish"; readonly atMs: number; readonly drained: boolean };

function offset(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error("Meeting time must be finite, nonnegative and within the safe range");
  }
}

function counter(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid meeting counter");
}

function identifier(value: string): void {
  if (!value.trim() || value.length > 256) throw new Error("Invalid meeting identifier");
}

function sources(selection: MeetingCaptureSelection): readonly string[] {
  return selection.mode === "microphone-only"
    ? [selection.microphone.sourceId]
    : [selection.microphone.sourceId, selection.outputSourceId];
}

function checkSelection(selection: MeetingCaptureSelection): void {
  identifier(selection.microphone.sourceId);
  identifier(selection.microphone.deviceId);
  if (selection.mode === "microphone-only") return;
  identifier(selection.outputSourceId);
  if (selection.outputSourceId === selection.microphone.sourceId)
    throw new Error("Sources must differ");
  if (selection.mode === "selected-app") {
    identifier(selection.appProcessTreeId);
  } else if (selection.mode === "computer-audio") {
    if (selection.scope.kind === "endpoint") identifier(selection.scope.endpointId);
    else if (selection.scope.kind === "process-exclusion") {
      if (!selection.scope.excludedProcessTreeIds.length)
        throw new Error("Exclusions are required");
      selection.scope.excludedProcessTreeIds.forEach(identifier);
    } else throw new Error("Invalid output scope");
  } else throw new Error("Explicit capture mode required");
}

function checkReadiness(selection: MeetingCaptureSelection, readiness: MeetingReadiness): void {
  const usable = ["audio", "silence", "muted"];
  if (
    !readiness.permissionsGranted ||
    !readiness.processingReady ||
    !readiness.noticeAcknowledged ||
    !usable.includes(readiness.microphone) ||
    (selection.mode === "microphone-only"
      ? readiness.output !== "not-captured"
      : !usable.includes(readiness.output))
  ) {
    throw new Error("Meeting is not ready");
  }
}

function checkProcessing(processing: MeetingProcessingCapabilities): void {
  for (const profile of [
    processing.transcription,
    processing.summary,
    processing.chat,
    processing.speakers.kind === "diarization" ? processing.speakers : null
  ]) {
    if (profile) {
      identifier(profile.profileId);
      counter(profile.profileVersion);
    }
  }
}

export function createMeetingLifecycle(meetingId: string): MeetingLifecycle {
  identifier(meetingId);
  return {
    meetingId,
    status: "draft",
    selection: null,
    processing: null,
    epochs: [],
    lastTransitionMs: 0,
    stop: null,
    retainedAudioPermitted: false,
    finalizationOutcome: null
  };
}

function closeEpoch(
  epochs: readonly MeetingCaptureEpoch[],
  atMs: number,
  boundaries: readonly MeetingSourceBoundary[]
): readonly MeetingCaptureEpoch[] {
  const current = epochs.at(-1);
  if (!current || current.endMs !== null) throw new Error("No active capture epoch");
  const expected = sources(current.selection);
  if (
    boundaries.length !== expected.length ||
    new Set(boundaries.map((b) => b.sourceId)).size !== expected.length ||
    boundaries.some((b) => !expected.includes(b.sourceId))
  )
    throw new Error("Exact source boundaries required");
  boundaries.forEach((b) => {
    if (b.finalSequence !== null) counter(b.finalSequence);
  });
  return [
    ...epochs.slice(0, -1),
    { ...current, endMs: atMs, boundaries: structuredClone(boundaries) }
  ];
}

/** Pure foundation only: callers must stop devices and enforce dispatch decisions on the real path. */
export function transitionMeeting(
  state: MeetingLifecycle,
  command: MeetingLifecycleCommand
): MeetingLifecycle {
  offset(command.atMs);
  // A repeated Stop cannot extend either the cutoff or its finalization deadline.
  if (command.type === "stop" && state.stop) return state;
  if (command.atMs < state.lastTransitionMs)
    throw new Error("Meeting chronology cannot move backwards");
  const next = { ...state, lastTransitionMs: command.atMs };
  switch (command.type) {
    case "ready": {
      if (state.status !== "draft" && state.status !== "ready")
        throw new Error("Cannot prepare an active meeting");
      checkSelection(command.selection);
      checkReadiness(command.selection, command.readiness);
      checkProcessing(command.processing);
      return {
        ...next,
        status: "ready",
        selection: structuredClone(command.selection),
        processing: structuredClone(command.processing)
      };
    }
    case "start": {
      if (state.status !== "ready" || !state.selection) throw new Error("Start requires readiness");
      checkReadiness(state.selection, command.readiness);
      return {
        ...next,
        status: "recording",
        epochs: [
          {
            epoch: 1,
            selection: state.selection,
            startMs: command.atMs,
            endMs: null,
            boundaries: []
          }
        ]
      };
    }
    case "pause": {
      if (state.status !== "recording") throw new Error("Pause requires recording");
      return {
        ...next,
        status: "paused",
        retainedAudioPermitted: false,
        epochs: closeEpoch(state.epochs, command.atMs, command.boundaries)
      };
    }
    case "resume": {
      if (state.status !== "paused") throw new Error("Resume requires Pause");
      checkSelection(command.selection);
      checkReadiness(command.selection, command.readiness);
      const epoch = state.epochs.length + 1;
      counter(epoch);
      const selection = structuredClone(command.selection);
      return {
        ...next,
        status: "recording",
        selection,
        retainedAudioPermitted: command.permitRetainedAudio,
        epochs: [
          ...state.epochs,
          { epoch, selection, startMs: command.atMs, endMs: null, boundaries: [] }
        ]
      };
    }
    case "stop": {
      if (state.status !== "recording" && state.status !== "paused")
        throw new Error("Stop requires a started meeting");
      offset(command.finalizationMs);
      if (command.finalizationMs > 60_000)
        throw new Error("Finalization exceeds the bounded window");
      const deadlineMs = command.atMs + command.finalizationMs;
      offset(deadlineMs);
      if (state.status === "paused" && command.boundaries.length)
        throw new Error("Paused boundaries are already fixed");
      return {
        ...next,
        status: "stopping",
        stop: { cutoffMs: command.atMs, deadlineMs },
        epochs:
          state.status === "recording"
            ? closeEpoch(state.epochs, command.atMs, command.boundaries)
            : state.epochs
      };
    }
    case "finish": {
      if (state.status !== "stopping" || !state.stop) throw new Error("Finalization requires Stop");
      if (!command.drained && command.atMs < state.stop.deadlineMs)
        throw new Error("Finalization is still pending");
      return {
        ...next,
        status: "processing",
        finalizationOutcome: command.drained ? "drained" : "deadline-expired"
      };
    }
  }
}

/** Whether a NEW send may begin; in-flight responses are not capture or a new send.
 * Intervals ending exactly at the cutoff are eligible; the finalization deadline is exclusive.
 * This is not envelope deduplication, retention, authorization, or provider routing.
 */
export function canSendMeetingAudio(
  state: MeetingLifecycle,
  audio: MeetingAudioEnvelope,
  nowMs: number
): boolean {
  try {
    offset(nowMs);
    offset(audio.startMs);
    offset(audio.endMs);
    counter(audio.epoch);
    counter(audio.sequence);
    if (
      audio.meetingId !== state.meetingId ||
      audio.startMs >= audio.endMs ||
      nowMs < audio.endMs ||
      nowMs < state.lastTransitionMs ||
      !Number.isInteger(audio.sampleRateHz) ||
      audio.sampleRateHz < 8000 ||
      audio.sampleRateHz > 192000 ||
      audio.channels !== 1 ||
      audio.format !== "pcm-s16le" ||
      !/^[a-f0-9]{64}$/.test(audio.contentHash)
    )
      return false;
    const epoch = state.epochs[audio.epoch - 1];
    if (
      !epoch ||
      !sources(epoch.selection).includes(audio.sourceId) ||
      audio.startMs < epoch.startMs
    )
      return false;
    if (epoch.endMs !== null) {
      const boundary = epoch.boundaries.find((b) => b.sourceId === audio.sourceId);
      if (
        audio.endMs > epoch.endMs ||
        !boundary ||
        boundary.finalSequence === null ||
        audio.sequence > boundary.finalSequence
      )
        return false;
    }
    if (state.status === "recording") return epoch.endMs === null || state.retainedAudioPermitted;
    return (
      state.status === "stopping" &&
      state.stop !== null &&
      audio.endMs <= state.stop.cutoffMs &&
      nowMs < state.stop.deadlineMs
    );
  } catch {
    return false;
  }
}
