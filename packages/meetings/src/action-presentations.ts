import { createHash } from "node:crypto";
import { assertDataContextDb, isUuid, type DataContextDb } from "@moss/db";
import {
  approvalBoolean,
  approvalChoice,
  approvalText,
  presentApprovalFields,
  type ApprovalField,
  type ApprovalFieldMap,
  type ApprovalFieldPresenter,
  type RouteApprovalInput,
  type RouteApprovalPresentation
} from "@moss/module-sdk";
import type {
  IngestMeetingTranscriptInput,
  MeetingOutputInputs,
  MeetingCaptureInventory,
  MeetingRememberedSource,
  MeetingRecord,
  MeetingTranscriptLedger
} from "@moss/shared";
import { MeetingRecordsRepository } from "./repository.js";
import { MeetingOutputsRepository } from "./output-repository.js";
import { MeetingTranscriptRepository } from "./transcript-repository.js";
import { encodeMeetingTranscriptBatch } from "./transcript-batch.js";
import { getMeetingOutputTemplate, validateMeetingOutput } from "./output-validation.js";
import { MeetingPreferencesRepository, savedCaptureSelection } from "./preferences.js";
import { MeetingCaptureConnectionRepository } from "./capture-connection-repository.js";

const records = new MeetingRecordsRepository();
const outputs = new MeetingOutputsRepository();
const transcripts = new MeetingTranscriptRepository();
const version = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (label: string) => ({ label, present: approvalText });
const count = (label: string, minimum = 0) => ({
  label,
  present: (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
      ? String(value)
      : null
});
const identifier = (value: unknown): value is string =>
  typeof value === "string" && !!value.trim() && !value.includes("\0") && value.length <= 256;
// A request key is a retry identity, not a user-selected resource. Validate and pin it in the
// server-only snapshot; the card explains its effect without exposing a raw internal token.
const requestKey = {
  label: "Repeated request",
  present: (value: unknown) =>
    typeof value === "string" && isUuid(value)
      ? "An identical retry uses the original result instead of repeating the change"
      : null
};
const nullableText = (label: string) => ({
  label,
  present: (value: unknown) => (value === null ? "Not specified" : approvalText(value))
});
function list(
  label: string,
  present: (value: unknown, index: number) => readonly ApprovalField[] | null,
  maximum = 100
): { label: string; present: ApprovalFieldPresenter } {
  return {
    label,
    present: (value) => {
      if (!Array.isArray(value) || value.length > maximum) return null;
      if (value.length === 0) return "None";
      const result: ApprovalField[] = [];
      for (const [index, item] of Array.from(value).entries()) {
        const fields = present(item, index);
        if (!fields) return null;
        result.push(
          ...fields.map((field) => ({
            label: `${label} ${index + 1} · ${field.label}`,
            value: field.value
          }))
        );
      }
      return result;
    }
  };
}
function params(input: RouteApprovalInput, meeting = false): boolean {
  if (Object.keys(input.query ?? {}).length) return false;
  return meeting
    ? Object.keys(input.params).length === 1 &&
        typeof input.params.id === "string" &&
        isUuid(input.params.id)
    : Object.keys(input.params).length === 0;
}
async function target(db: DataContextDb, input: RouteApprovalInput): Promise<MeetingRecord | null> {
  return params(input, true) ? records.get(db, input.params.id!) : null;
}

export const createMeetingPresentation: RouteApprovalPresentation = async (_db, input) => {
  if (!params(input)) return null;
  const fields = presentApprovalFields(input.body, { requestKey, title: text("Title") }, [
    "requestKey",
    "title"
  ]);
  if (!fields) return null;
  const body = input.body as { title: string };
  if (!body.title.trim()) return null;
  return { target: body.title, fields, version: version(input.body) };
};
const captureMode = approvalChoice({
  "microphone-only": "Microphone only",
  "selected-app": "Selected app and microphone",
  "computer-audio": "Computer audio and microphone"
});
const preferences = new MeetingPreferencesRepository();
const connections = new MeetingCaptureConnectionRepository();

async function rememberedSourceDetails(db: DataContextDb, value: unknown, ownerUserId: string) {
  const identity = (label: string) => ({
    label,
    present: (entry: unknown) => (identifier(entry) ? entry : null)
  });
  if (
    !presentApprovalFields(
      value,
      {
        deviceId: {
          label: "Mac",
          present: (entry) => (typeof entry === "string" && isUuid(entry) ? entry : null)
        },
        microphoneId: identity("Microphone"),
        applicationId: identity("Application"),
        mode: { label: "Audio source", present: captureMode }
      },
      ["deviceId", "microphoneId", "mode"]
    )
  )
    return null;
  const source = value as MeetingRememberedSource;
  if (source.mode === "selected-app" && !source.applicationId) return null;
  const connection = await connections.connection(db, source.deviceId);
  if (
    !connection ||
    connection.device_id !== source.deviceId ||
    connection.owner_user_id !== ownerUserId ||
    connection.expires_at.getTime() <= Date.now() ||
    !connection.device_name.trim()
  )
    return null;
  let inventory: MeetingCaptureInventory;
  try {
    inventory = JSON.parse(connection.inventory_json) as MeetingCaptureInventory;
    savedCaptureSelection(source, inventory);
  } catch {
    return null;
  }
  const microphone = inventory.microphones.find((item) => item.deviceId === source.microphoneId)!;
  const applications =
    source.applicationId === undefined
      ? []
      : inventory.applications.filter((item) => item.applicationId === source.applicationId);
  if (
    !microphone.label.trim() ||
    (source.applicationId !== undefined &&
      (applications.length !== 1 || !applications[0]!.label.trim()))
  )
    return null;
  const fields: ApprovalField[] = [
    { label: "Recording Mac", value: connection.device_name },
    { label: "Microphone", value: microphone.label },
    { label: "Remembered audio source", value: captureMode(source.mode) as string },
    ...(applications.length ? [{ label: "Application", value: applications[0]!.label }] : [])
  ];
  return {
    fields,
    // Only reference metadata participates in revalidation, never recorder credentials.
    reference: [
      connection.device_id,
      connection.connection_id,
      connection.revision,
      connection.capability_revision,
      fields
    ]
  };
}

export const meetingTitlePresentation: RouteApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  const title = (label: string) => ({
    label,
    present: (value: unknown) =>
      typeof value === "string" &&
      !!value.trim() &&
      !value.includes("\0") &&
      Buffer.byteLength(value) <= 240
        ? value
        : null
  });
  const fields = presentApprovalFields(
    input.body,
    {
      expectedTitle: title("Current title"),
      title: title("New title")
    },
    ["expectedTitle", "title"]
  );
  if (!fields) return null;
  const meeting = await target(db, input);
  return meeting
    ? { target: meeting.title, fields, version: version([meeting, input.body]) }
    : null;
};
export const meetingPreferencesPresentation: RouteApprovalPresentation = async (db, input, ctx) => {
  assertDataContextDb(db);
  if (!params(input) || !input.body || typeof input.body !== "object" || Array.isArray(input.body))
    return null;
  const body = input.body as Record<string, unknown>;
  if (Object.keys(body).length === 0) return null;
  const source =
    body.rememberedSource == null
      ? null
      : await rememberedSourceDetails(db, body.rememberedSource, ctx.actorUserId);
  if (body.rememberedSource != null && !source) return null;
  const [current, persistedDefault] = await Promise.all([
    preferences.get(db),
    preferences.getPersistedDefaultCaptureMode(db)
  ]);
  const effectiveSource =
    body.rememberedSource === undefined
      ? current.rememberedSource
      : (body.rememberedSource as MeetingRememberedSource | null);
  const fields = presentApprovalFields(body, {
    defaultCaptureMode: {
      label: "Default capture source",
      present: (value) =>
        value === null ? captureMode(effectiveSource?.mode ?? "computer-audio") : captureMode(value)
    },
    summarizeOnStop: { label: "Summarize automatically after Stop", present: approvalBoolean },
    summaryTemplateId: {
      label: "Summary style",
      present: (value) =>
        typeof value === "string" ? (getMeetingOutputTemplate(value, 1)?.name ?? null) : null
    },
    rememberedSource: {
      label: "Remembered recording source",
      present: (value) =>
        value === null
          ? "Clear the saved Mac, microphone and application"
          : (source?.fields ?? null)
    }
  });
  if (!fields) return null;
  // update() only persists an explicit default. Without one, the next get() derives
  // its mode from the newly saved source, not the previous source's fallback.
  const nextMode =
    body.defaultCaptureMode === undefined
      ? (persistedDefault ?? effectiveSource?.mode ?? "computer-audio")
      : (body.defaultCaptureMode ?? effectiveSource?.mode ?? "computer-audio");
  const changes = [
    ...(Object.hasOwn(body, "rememberedSource")
      ? [
          body.rememberedSource === null
            ? "Clear the saved recording source"
            : "Change the saved recording source"
        ]
      : []),
    ...(Object.hasOwn(body, "defaultCaptureMode") ? ["Change the default recording audio"] : []),
    ...(Object.hasOwn(body, "summarizeOnStop")
      ? [body.summarizeOnStop ? "Turn on automatic summaries" : "Turn off automatic summaries"]
      : []),
    ...(Object.hasOwn(body, "summaryTemplateId") ? ["Change the summary style"] : [])
  ];
  return {
    title: changes.join("; "),
    target: "Meeting capture preferences",
    fields: [
      ...fields,
      ...(Object.hasOwn(body, "rememberedSource")
        ? [
            {
              label: "Next recording audio",
              value: `${captureMode(nextMode)}${nextMode === "selected-app" && !effectiveSource ? "; choose an application before recording" : ""}`
            }
          ]
        : [])
    ],
    version: version([body, current, persistedDefault, source?.reference])
  };
};
export const deleteMeetingPresentation: RouteApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  if (!presentApprovalFields(input.body, {})) return null;
  const meeting = await target(db, input);
  return meeting
    ? {
        target: meeting.title,
        fields: [
          {
            label: "Delete",
            value:
              "This meeting, its retained notes, transcript, summaries, action reviews and export receipts, and its linked Moss chats"
          }
        ],
        version: version(meeting)
      }
    : null;
};
export const meetingNotesPresentation: RouteApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  const fields = presentApprovalFields(
    input.body,
    {
      requestKey,
      expectedRevision: count("Based on notes revision"),
      personalNotes: text("Personal notes")
    },
    ["requestKey", "expectedRevision", "personalNotes"]
  );
  if (!fields) return null;
  const meeting = await target(db, input);
  return meeting
    ? { target: meeting.title, fields, version: version([meeting, input.body]) }
    : null;
};

function evidenceFields(inputs: MeetingOutputInputs, title: string): ApprovalFieldMap {
  const meeting = {
    label: "Meeting",
    present: (value: unknown) => (value === inputs.meetingId ? title : null)
  };
  return {
    overview: text("Overview"),
    decisions: list(
      "Decision",
      (value) =>
        presentApprovalFields(
          value,
          {
            text: text("Text"),
            evidence: evidenceList(inputs, meeting)
          },
          ["text", "evidence"]
        ),
      50
    ),
    openQuestions: list(
      "Open question",
      (value) => (typeof value === "string" ? [{ label: "Text", value }] : null),
      50
    ),
    actions: list(
      "Suggested action",
      (value) =>
        presentApprovalFields(
          value,
          {
            text: text("Text"),
            evidence: evidenceList(inputs, meeting),
            ownerPhrase: nullableText("Owner phrase"),
            duePhrase: nullableText("Due phrase")
          },
          ["text", "evidence", "ownerPhrase", "duePhrase"]
        ),
      50
    ),
    warnings: list(
      "Warning",
      (value) => (typeof value === "string" ? [{ label: "Text", value }] : null),
      50
    )
  };
}
function evidenceList(inputs: MeetingOutputInputs, meeting: ApprovalFieldMap[string]) {
  return list(
    "Evidence",
    (value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const reference = value as Record<string, unknown>;
      const common: ApprovalFieldMap = {
        meetingId: meeting,
        startCharacter: count("Start character (UTF-16)"),
        endCharacter: count("End character (exclusive, UTF-16)")
      };
      let fields: readonly ApprovalField[] | null;
      let source: string;
      if (reference.kind === "personal-note") {
        fields = presentApprovalFields(
          value,
          {
            ...common,
            kind: {
              label: "Source",
              present: approvalChoice({ "personal-note": "Personal notes" })
            },
            notesRevision: {
              label: "Notes revision",
              present: (value) => (value === inputs.notesRevision ? String(value) : null)
            }
          },
          ["kind", "meetingId", "notesRevision", "startCharacter", "endCharacter"]
        );
        source = inputs.personalNotes;
      } else if (reference.kind === "transcript") {
        const segment = inputs.transcript?.segments.find(
          (entry) =>
            entry.segmentId === reference.segmentId && entry.revision === reference.segmentRevision
        );
        if (!segment) return null;
        fields = presentApprovalFields(
          value,
          {
            ...common,
            kind: {
              label: "Source",
              present: approvalChoice({ transcript: "Retained transcript" })
            },
            segmentId: {
              label: "Passage",
              present: (value) =>
                value === segment.segmentId
                  ? `${segment.startMs}–${segment.endMs} ms: ${segment.text}`
                  : null
            },
            segmentRevision: {
              label: "Passage revision",
              present: (value) => (value === segment.revision ? String(value) : null)
            }
          },
          ["kind", "meetingId", "segmentId", "segmentRevision", "startCharacter", "endCharacter"]
        );
        source = segment.text;
      } else return null;
      // The owning output validator checks exact ranges, revisions and surrogate boundaries.
      return fields
        ? [
            ...fields,
            {
              label: "Exact excerpt",
              value: source.slice(
                reference.startCharacter as number,
                reference.endCharacter as number
              )
            }
          ]
        : null;
    },
    10
  );
}
export const meetingSummaryPresentation: RouteApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  const meeting = await target(db, input);
  if (!meeting || !input.body || typeof input.body !== "object" || Array.isArray(input.body))
    return null;
  const body = input.body as Record<string, unknown>;
  if (
    typeof body.expectedOutputVersion !== "number" ||
    !Number.isSafeInteger(body.expectedOutputVersion) ||
    body.expectedOutputVersion < 1
  )
    return null;
  const artifact = await outputs.getArtifact(db, meeting.id, body.expectedOutputVersion);
  if (!artifact || artifact.meetingId !== meeting.id || artifact.inputs.meetingId !== meeting.id)
    return null;
  try {
    validateMeetingOutput(body.content, artifact.inputs);
  } catch {
    return null;
  }
  const fields = presentApprovalFields(
    body,
    {
      requestKey,
      expectedOutputVersion: count("Based on summary version", 1),
      content: {
        label: "Summary",
        present: (value) =>
          presentApprovalFields(value, evidenceFields(artifact.inputs, meeting.title), [
            "overview",
            "decisions",
            "openQuestions",
            "actions",
            "warnings"
          ])
      }
    },
    ["requestKey", "expectedOutputVersion", "content"]
  );
  return fields
    ? { target: meeting.title, fields, version: version([meeting, artifact, body]) }
    : null;
};

function transcriptFields(
  batch: IngestMeetingTranscriptInput,
  meeting: MeetingRecord,
  ledger: MeetingTranscriptLedger | null
): ApprovalFieldMap {
  const previous = new Map(
    ledger?.revisions.map((entry) => [entry.segment.segmentId, entry.segment])
  );
  const newPassages = new Map<string, number>();
  for (const event of batch.events) {
    if (!previous.has(event.segment.segmentId) && !newPassages.has(event.segment.segmentId)) {
      newPassages.set(event.segment.segmentId, newPassages.size + 1);
    }
  }
  const speakers = new Map<string, number>();
  for (const revision of ledger?.revisions ?? []) {
    const id = revision.segment.speakerId;
    if (id !== null && !speakers.has(id)) speakers.set(id, speakers.size + 1);
  }
  for (const event of batch.events) {
    const id = event.segment.speakerId;
    if (id !== null && !speakers.has(id)) speakers.set(id, speakers.size + 1);
  }
  return {
    requestKey,
    expectedVersion: count("Based on transcript batch version"),
    stopCutoffMs: {
      label: "Stop cutoff",
      present: (value) =>
        value === null
          ? "Not set"
          : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
            ? `${value} ms`
            : null
    },
    sources: list(
      "Source",
      (value, index) => {
        const source = batch.sources[index]!;
        return presentApprovalFields(
          value,
          {
            sourceId: {
              label: "Source",
              present: (value) =>
                value === source.sourceId && identifier(value) ? source.label : null
            },
            epoch: count("Capture interval", 1),
            kind: {
              label: "Kind",
              present: approvalChoice({ microphone: "Microphone", output: "Computer audio" })
            },
            label: text("Label"),
            startMs: count("Start (ms)"),
            endMs: count("End (ms)")
          },
          ["sourceId", "epoch", "kind", "label", "startMs", "endMs"]
        );
      },
      128
    ),
    events: list("Transcript event", (value, index) => {
      const segment = batch.events[index]!.segment;
      const source = batch.sources.find(
        (entry) => entry.sourceId === segment.sourceId && entry.epoch === segment.epoch
      );
      if (!source) return null;
      const sourceName = `Source ${batch.sources.indexOf(source) + 1}: ${source.label}`;
      const old = previous.get(segment.segmentId);
      return presentApprovalFields(
        value,
        {
          cursor: count("Event order", 1),
          segment: {
            label: "Passage",
            present: (value) =>
              presentApprovalFields(
                value,
                {
                  meetingId: {
                    label: "Meeting",
                    present: (value) =>
                      typeof value === "string" && value.toLowerCase() === meeting.id.toLowerCase()
                        ? meeting.title
                        : null
                  },
                  segmentId: {
                    label: "Passage",
                    present: (value) =>
                      value === segment.segmentId && identifier(value)
                        ? old
                          ? `Existing passage at ${old.startMs}–${old.endMs} ms: ${old.text}`
                          : `New passage ${newPassages.get(segment.segmentId)}`
                        : null
                  },
                  sourceId: {
                    label: "Source",
                    present: (value) => (value === source.sourceId ? sourceName : null)
                  },
                  epoch: count("Capture interval", 1),
                  startMs: count("Start (ms)"),
                  endMs: count("End (ms)"),
                  revision: count("Passage revision", 1),
                  text: text("Text"),
                  finality: {
                    label: "Text status",
                    present: approvalChoice({ provisional: "Provisional", final: "Final" })
                  },
                  provenance: {
                    label: "Text origin",
                    present: approvalChoice({
                      transcription: "Transcription",
                      correction: "Correction"
                    })
                  },
                  speakerId: {
                    label: "Speaker group",
                    present: (value) =>
                      value === null
                        ? "Unknown"
                        : identifier(value) && speakers.has(value)
                          ? `Meeting-local speaker ${speakers.get(value)} (identity unverified)`
                          : null
                  }
                },
                [
                  "meetingId",
                  "segmentId",
                  "sourceId",
                  "epoch",
                  "startMs",
                  "endMs",
                  "revision",
                  "text",
                  "finality",
                  "provenance",
                  "speakerId"
                ]
              )
          }
        },
        ["cursor", "segment"]
      );
    })
  };
}
export const meetingTranscriptPresentation: RouteApprovalPresentation = async (db, input) => {
  assertDataContextDb(db);
  const meeting = await target(db, input);
  if (!meeting || !input.body || typeof input.body !== "object" || Array.isArray(input.body))
    return null;
  const batch = { ...input.body, meetingId: meeting.id } as IngestMeetingTranscriptInput;
  // Same pure shape validation as ingestion; does not execute or alter the request.
  try {
    encodeMeetingTranscriptBatch(batch);
  } catch {
    return null;
  }
  const state = await transcripts.approvalSnapshot(db, meeting.id);
  if (!state) return null;
  const fields = presentApprovalFields(input.body, transcriptFields(batch, meeting, state.ledger), [
    "requestKey",
    "expectedVersion",
    "sources",
    "events",
    "stopCutoffMs"
  ]);
  return fields
    ? { target: meeting.title, fields, version: version([meeting, state, input.body]) }
    : null;
};
