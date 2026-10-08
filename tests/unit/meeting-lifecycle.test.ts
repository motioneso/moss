import { describe, expect, it } from "vitest";
import type {
  MeetingAudioEnvelope,
  MeetingCaptureSelection,
  MeetingProcessingCapabilities,
  MeetingReadiness
} from "../../packages/shared/src/meeting-api.js";
import {
  canSendMeetingAudio,
  createMeetingLifecycle,
  transitionMeeting
} from "../../packages/meetings/src/lifecycle.js";

const selection: MeetingCaptureSelection = {
  mode: "microphone-only",
  microphone: { sourceId: "mic", deviceId: "device" }
};
const readiness: MeetingReadiness = {
  microphone: "silence",
  output: "not-captured",
  permissionsGranted: true,
  processingReady: true
};
const processing: MeetingProcessingCapabilities = {
  transcription: {
    profileId: "asr",
    profileVersion: 1,
    transport: "chunks",
    timestamps: true,
    revisions: false
  },
  speakers: { kind: "source-labels-only" },
  summary: null,
  chat: null
};
const boundaries = [{ sourceId: "mic", finalSequence: 2 }];
const audio: MeetingAudioEnvelope = {
  meetingId: "meeting",
  sourceId: "mic",
  epoch: 1,
  sequence: 2,
  startMs: 0,
  endMs: 10,
  format: "pcm-s16le",
  sampleRateHz: 16000,
  channels: 1,
  contentHash: "a".repeat(64)
};
function ready() {
  return transitionMeeting(createMeetingLifecycle("meeting"), {
    type: "ready",
    atMs: 0,
    selection,
    readiness,
    processing
  });
}
function recording() {
  return transitionMeeting(ready(), { type: "start", atMs: 0, readiness });
}
function paused() {
  return transitionMeeting(recording(), { type: "pause", atMs: 10, boundaries });
}
function stopped() {
  return transitionMeeting(recording(), {
    type: "stop",
    atMs: 10,
    boundaries,
    finalizationMs: 60_000
  });
}

describe("meeting lifecycle foundation", () => {
  it("captures system audio alone with exact output boundaries and no microphone readiness", () => {
    const selection: MeetingCaptureSelection = {
      mode: "computer-audio",
      microphone: null,
      outputSourceId: "output",
      scope: { kind: "process-exclusion", excludedProcessTreeIds: ["moss"] }
    };
    const readyInput = {
      ...readiness,
      microphone: "not-captured" as const,
      output: "silence" as const
    };
    const ready = transitionMeeting(createMeetingLifecycle("meeting"), {
      type: "ready",
      atMs: 0,
      selection,
      readiness: readyInput,
      processing
    });
    const active = transitionMeeting(ready, { type: "start", atMs: 0, readiness: readyInput });
    expect(canSendMeetingAudio(active, { ...audio, sourceId: "output" }, 10)).toBe(true);
    expect(canSendMeetingAudio(active, audio, 10)).toBe(false);
    expect(
      transitionMeeting(active, {
        type: "pause",
        atMs: 10,
        boundaries: [{ sourceId: "output", finalSequence: 2 }]
      }).status
    ).toBe("paused");
    expect(() => transitionMeeting(active, { type: "pause", atMs: 10, boundaries })).toThrow();
    expect(() =>
      transitionMeeting(ready, {
        type: "start",
        atMs: 0,
        readiness: { ...readyInput, microphone: "audio" }
      })
    ).toThrow();
  });
  it("requires explicit readiness and freshly checked Start", () => {
    expect(() =>
      transitionMeeting(createMeetingLifecycle("meeting"), { type: "start", atMs: 0, readiness })
    ).toThrow();
    expect(() =>
      transitionMeeting(ready(), {
        type: "start",
        atMs: 0,
        readiness: { ...readiness, processingReady: false }
      })
    ).toThrow();
    expect(recording().status).toBe("recording");
  });
  it.each(["disconnected", "permission-missing", "no-stream", "not-captured"] as const)(
    "rejects microphone %s without broadening scope",
    (microphone) => {
      expect(() =>
        transitionMeeting(createMeetingLifecycle("meeting"), {
          type: "ready",
          atMs: 0,
          selection,
          processing,
          readiness: { ...readiness, microphone }
        })
      ).toThrow();
      expect(selection.mode).toBe("microphone-only");
    }
  );
  it.each(["audio", "silence", "muted"] as const)(
    "distinguishes usable microphone state %s",
    (microphone) => {
      expect(
        transitionMeeting(ready(), {
          type: "start",
          atMs: 0,
          readiness: { ...readiness, microphone }
        }).status
      ).toBe("recording");
    }
  );
  it.each(["permissionsGranted", "processingReady"] as const)("requires %s", (key) => {
    expect(() =>
      transitionMeeting(ready(), {
        type: "start",
        atMs: 0,
        readiness: { ...readiness, [key]: false }
      })
    ).toThrow();
  });
  it("keeps microphone-only output off and processing capability snapshots independent", () => {
    expect(() =>
      transitionMeeting(ready(), {
        type: "start",
        atMs: 0,
        readiness: { ...readiness, output: "audio" }
      })
    ).toThrow();
    expect(ready().processing?.speakers).toEqual({ kind: "source-labels-only" });
    expect(ready().processing?.summary).toBeNull();
  });
  it("blocks every new send while paused, including queued pre-pause audio", () => {
    expect(canSendMeetingAudio(recording(), audio, 10)).toBe(true);
    expect(canSendMeetingAudio(paused(), audio, 10)).toBe(false);
    expect(canSendMeetingAudio(paused(), { ...audio, endMs: 9 }, 100)).toBe(false);
  });
  it("requires Pause, fresh readiness, explicit scope and retained-audio consent on Resume", () => {
    const app: MeetingCaptureSelection = {
      mode: "selected-app",
      microphone: selection.microphone,
      outputSourceId: "app",
      appProcessTreeId: "teams-1"
    };
    const command = {
      type: "resume",
      atMs: 20,
      selection: app,
      readiness: { ...readiness, output: "silence" },
      permitRetainedAudio: false
    } as const;
    expect(() => transitionMeeting(recording(), command)).toThrow();
    expect(() => transitionMeeting(paused(), { ...command, readiness })).toThrow();
    const resumed = transitionMeeting(paused(), command);
    expect(resumed.epochs.map((epoch) => [epoch.epoch, epoch.startMs, epoch.endMs])).toEqual([
      [1, 0, 10],
      [2, 20, null]
    ]);
    expect(resumed.selection).toEqual(app);
    expect(canSendMeetingAudio(resumed, audio, 30)).toBe(false);
    expect(
      canSendMeetingAudio(
        transitionMeeting(paused(), { ...command, permitRetainedAudio: true }),
        audio,
        30
      )
    ).toBe(true);
    expect(
      canSendMeetingAudio(
        resumed,
        { ...audio, sourceId: "app", epoch: 2, startMs: 20, endMs: 30 },
        30
      )
    ).toBe(true);
    expect(canSendMeetingAudio(resumed, { ...audio, sourceId: "app", epoch: 1 }, 30)).toBe(false);
    expect(canSendMeetingAudio(resumed, { ...audio, epoch: 2, startMs: 15, endMs: 25 }, 30)).toBe(
      false
    );
  });
  it("requires exact source boundaries and rejects unsafe counters", () => {
    for (const invalid of [
      [],
      [{ sourceId: "other", finalSequence: 1 }],
      [...boundaries, ...boundaries],
      [{ sourceId: "mic", finalSequence: NaN }],
      [{ sourceId: "mic", finalSequence: 0.5 }]
    ]) {
      expect(() =>
        transitionMeeting(recording(), { type: "pause", atMs: 10, boundaries: invalid })
      ).toThrow();
    }
    const empty = transitionMeeting(recording(), {
      type: "stop",
      atMs: 10,
      finalizationMs: 100,
      boundaries: [{ sourceId: "mic", finalSequence: null }]
    });
    expect(canSendMeetingAudio(empty, audio, 10)).toBe(false);
  });
  it("keeps Stop cutoff and deadline immutable across duplicate Stop", () => {
    const state = stopped();
    expect(
      transitionMeeting(state, { type: "stop", atMs: 20, boundaries: [], finalizationMs: 60_000 })
    ).toBe(state);
    expect(
      transitionMeeting(state, { type: "stop", atMs: 0, boundaries: [], finalizationMs: 0 })
    ).toBe(state);
    expect(() =>
      transitionMeeting(state, {
        type: "resume",
        atMs: 20,
        selection,
        readiness,
        permitRetainedAudio: true
      })
    ).toThrow();
    expect(() => transitionMeeting(state, { type: "start", atMs: 20, readiness })).toThrow();
  });
  it("allows only bounded pre-cutoff final partial chunks and sequence-bounded retries", () => {
    const state = stopped();
    expect(canSendMeetingAudio(state, audio, 10)).toBe(true);
    expect(canSendMeetingAudio(state, audio, 60_009)).toBe(true);
    expect(canSendMeetingAudio(state, audio, 60_010)).toBe(false);
    expect(canSendMeetingAudio(state, { ...audio, endMs: 11 }, 12)).toBe(false);
    expect(canSendMeetingAudio(state, { ...audio, sequence: 3 }, 12)).toBe(false);
    expect(canSendMeetingAudio(state, { ...audio, sourceId: "output" }, 12)).toBe(false);
    expect(canSendMeetingAudio(state, { ...audio, meetingId: "other" }, 12)).toBe(false);
  });
  it("preserves Pause boundaries when stopped later and sends no audio from its gap", () => {
    const state = transitionMeeting(paused(), {
      type: "stop",
      atMs: 50,
      boundaries: [],
      finalizationMs: 100
    });
    expect(state.stop?.cutoffMs).toBe(50);
    expect(canSendMeetingAudio(state, audio, 50)).toBe(true);
    expect(canSendMeetingAudio(state, { ...audio, endMs: 11 }, 50)).toBe(false);
    expect(() =>
      transitionMeeting(paused(), { type: "stop", atMs: 50, boundaries, finalizationMs: 100 })
    ).toThrow();
  });
  it("finishes only after draining or reaching the deadline, and never sends afterward", () => {
    expect(() =>
      transitionMeeting(stopped(), { type: "finish", atMs: 11, drained: false })
    ).toThrow();
    const finished = transitionMeeting(stopped(), { type: "finish", atMs: 60_010, drained: false });
    expect(finished.status).toBe("processing");
    expect(finished.finalizationOutcome).toBe("deadline-expired");
    expect(canSendMeetingAudio(finished, audio, 60_010)).toBe(false);
    expect(transitionMeeting(stopped(), { type: "finish", atMs: 10, drained: true }).status).toBe(
      "processing"
    );
    expect(() =>
      transitionMeeting(recording(), { type: "finish", atMs: 10, drained: true })
    ).toThrow();
  });
  it.each([-1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid chronology %s",
    (atMs) => {
      expect(() => transitionMeeting(recording(), { type: "pause", atMs, boundaries })).toThrow();
      expect(canSendMeetingAudio(recording(), audio, atMs)).toBe(false);
      expect(canSendMeetingAudio(recording(), { ...audio, startMs: atMs }, 10)).toBe(false);
      expect(canSendMeetingAudio(recording(), { ...audio, endMs: atMs }, 10)).toBe(false);
    }
  );
  it("rejects backwards time, future audio, empty intervals and invalid envelope numerics", () => {
    expect(() =>
      transitionMeeting(paused(), {
        type: "resume",
        atMs: 9,
        selection,
        readiness,
        permitRetainedAudio: true
      })
    ).toThrow();
    for (const patch of [
      { startMs: 10 },
      { startMs: 11 },
      { epoch: 0.5 },
      { sequence: Infinity },
      { sampleRateHz: 0 },
      { contentHash: "x" }
    ]) {
      expect(canSendMeetingAudio(recording(), { ...audio, ...patch }, 10)).toBe(false);
    }
    expect(canSendMeetingAudio(recording(), audio, 9)).toBe(false);
  });
  it("bounds finalization, including zero-window and overflow cases", () => {
    for (const finalizationMs of [-1, NaN, Infinity, 60_001])
      expect(() =>
        transitionMeeting(recording(), { type: "stop", atMs: 10, boundaries, finalizationMs })
      ).toThrow();
    expect(() =>
      transitionMeeting(recording(), {
        type: "stop",
        atMs: Number.MAX_SAFE_INTEGER,
        boundaries,
        finalizationMs: 1
      })
    ).toThrow();
    expect(
      canSendMeetingAudio(
        transitionMeeting(recording(), { type: "stop", atMs: 10, boundaries, finalizationMs: 0 }),
        audio,
        10
      )
    ).toBe(false);
  });
  it("does not mutate supplied selections, processing profiles or close boundaries", () => {
    const local = structuredClone(selection);
    const state = transitionMeeting(createMeetingLifecycle("meeting"), {
      type: "ready",
      atMs: 0,
      selection: local,
      processing,
      readiness
    });
    expect(state.selection).not.toBe(local);
    expect(state.processing).not.toBe(processing);
    expect(paused().epochs[0]?.boundaries).not.toBe(boundaries);
    expect(recording().epochs[0]?.endMs).toBeNull();
  });
  it("keeps endpoint scope precise and closes both tracks without assuming native coverage", () => {
    const computer: MeetingCaptureSelection = {
      mode: "computer-audio",
      microphone: selection.microphone,
      outputSourceId: "output",
      scope: { kind: "endpoint", endpointId: "headphones" }
    };
    const checked = { ...readiness, output: "silence" } as const;
    const prepared = transitionMeeting(createMeetingLifecycle("meeting"), {
      type: "ready",
      atMs: 0,
      selection: computer,
      processing,
      readiness: checked
    });
    const active = transitionMeeting(prepared, { type: "start", atMs: 0, readiness: checked });
    expect(active.selection).toEqual(computer);
    expect(() => transitionMeeting(active, { type: "pause", atMs: 10, boundaries })).toThrow();
    const closed = transitionMeeting(active, {
      type: "stop",
      atMs: 10,
      finalizationMs: 10,
      boundaries: [...boundaries, { sourceId: "output", finalSequence: 0 }]
    });
    expect(canSendMeetingAudio(closed, { ...audio, sourceId: "output", sequence: 0 }, 10)).toBe(
      true
    );
    expect(canSendMeetingAudio(closed, { ...audio, sourceId: "output", sequence: 1 }, 10)).toBe(
      false
    );
    expect(() =>
      transitionMeeting(prepared, {
        type: "ready",
        atMs: 0,
        selection: {
          ...computer,
          outputSourceId: "mic"
        },
        processing,
        readiness: checked
      })
    ).toThrow();
    expect(() =>
      transitionMeeting(prepared, {
        type: "ready",
        atMs: 0,
        selection: {
          ...computer,
          scope: { kind: "process-exclusion", excludedProcessTreeIds: [] }
        },
        processing,
        readiness: checked
      })
    ).toThrow();
  });
  it("rejects repeated invalid transitions without changing prior state", () => {
    expect(() => transitionMeeting(recording(), { type: "start", atMs: 1, readiness })).toThrow();
    expect(() => transitionMeeting(paused(), { type: "pause", atMs: 10, boundaries })).toThrow();
    expect(() =>
      transitionMeeting(recording(), { type: "ready", atMs: 10, selection, readiness, processing })
    ).toThrow();
    expect(() =>
      transitionMeeting(ready(), { type: "stop", atMs: 10, boundaries, finalizationMs: 10 })
    ).toThrow();
    expect(() =>
      transitionMeeting(recording(), { type: "pause", atMs: 0.5, boundaries })
    ).toThrow();
    expect(canSendMeetingAudio(recording(), { ...audio, epoch: 0 }, 10)).toBe(false);
  });
});
