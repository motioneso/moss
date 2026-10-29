import type { GenerateMeetingOutputInput } from "./meeting-output-api.js";

export type RecordingSide = "personal" | "work";
export interface RecordingType {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly templateId: GenerateMeetingOutputInput["templateId"];
  readonly retired: boolean;
}
export interface RecordingTypeConfiguration {
  readonly revision: number;
  readonly types: readonly RecordingType[];
}
export interface RecordingInterpretation {
  readonly title: string;
  readonly typeId: string;
  readonly side: RecordingSide;
  readonly confidence: number;
  readonly reason: string;
  readonly ideaGroups: readonly { readonly title: string; readonly ideas: readonly string[] }[];
}
export interface RecordingMetadata {
  readonly meetingId: string;
  readonly revision: number;
  readonly typeId: string | null;
  readonly typeSource: "automatic" | "user";
  readonly titleSource: "automatic" | "user";
  readonly side: RecordingSide | null;
  readonly confidence: number | null;
  readonly reason: string | null;
  readonly recordedAt: string | null;
  readonly source: "recording" | "manual-transcript";
  readonly outputVersion: number | null;
}
export interface RecordingOutputContext {
  readonly metadata: RecordingMetadata;
  readonly configuration: RecordingTypeConfiguration;
}
export interface ManualTranscriptInput {
  readonly requestKey: string;
  readonly title?: string;
  readonly typeId?: string;
  readonly recordedAt?: string;
  readonly transcript: string;
}
export const recordingTypeIdSchema = { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" } as const;
export const manualTranscriptSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["requestKey", "transcript"],
    properties: {
      requestKey: { type: "string", format: "uuid" },
      title: { type: "string", minLength: 1, maxLength: 240 },
      typeId: recordingTypeIdSchema,
      recordedAt: { type: "string", format: "date-time" },
      transcript: { type: "string", minLength: 1, maxLength: 100000 }
    }
  }
} as const;
export const putRecordingTypeSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["expectedRevision", "typeId"],
    properties: {
      expectedRevision: { type: "integer", minimum: 0, maximum: 2147483646 },
      typeId: recordingTypeIdSchema
    }
  }
} as const;

export interface PutRecordingTypeConfigurationInput {
  readonly expectedRevision: number;
  readonly types: readonly RecordingType[];
}
export const putRecordingTypeConfigurationSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["expectedRevision", "types"],
    properties: {
      expectedRevision: {
        type: "integer",
        minimum: 0,
        maximum: 2147483646,
        description: "Revision from the complete current recording-type configuration."
      },
      types: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        description:
          "Complete type list, retaining all existing IDs. Remove a type by retiring it; new types use general style unless requested otherwise.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "description", "templateId", "retired"],
          properties: {
            id: {
              ...recordingTypeIdSchema,
              description: "Stable ID; never change or reuse an existing ID."
            },
            name: {
              type: "string",
              minLength: 1,
              maxLength: 80,
              description: "User-facing unique type name."
            },
            description: {
              type: "string",
              minLength: 1,
              maxLength: 500,
              description: "Short classification description based on the user's request."
            },
            templateId: {
              type: "string",
              enum: ["general", "one-to-one", "project-review", "interview"],
              description: "Summary style; general for a new type unless the user chooses another."
            },
            retired: {
              type: "boolean",
              description:
                "True removes the type from new selection while preserving old recordings."
            }
          }
        }
      }
    }
  }
} as const;
