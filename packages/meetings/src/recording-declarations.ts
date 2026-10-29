import type { MossModuleManifest } from "@moss/module-sdk";
import { recordingTypeConfigurationPresentation } from "./recording-type-presentations.js";
export const recordingIdentityRoutes = [
  {
    method: "GET",
    path: "/api/meetings/recording-types",
    permissionId: "meetings.read",
    chat: { access: "read", content: "user_authored" }
  },
  {
    method: "PUT",
    path: "/api/meetings/recording-types",
    permissionId: "meetings.write",
    chat: {
      access: "write",
      content: "user_authored",
      title: "Add, rename, describe, restyle or retire recording types",
      presentation: recordingTypeConfigurationPresentation
    }
  },
  {
    method: "GET",
    path: "/api/meetings/records/:id/recording",
    permissionId: "meetings.read",
    chat: { access: "read", content: "user_authored" }
  },
  {
    method: "PUT",
    path: "/api/meetings/records/:id/recording/type",
    permissionId: "meetings.write",
    chat: { access: "blocked", blockedBecause: "external_effect" }
  },
  {
    method: "POST",
    path: "/api/meetings/manual-transcripts",
    permissionId: "meetings.write",
    chat: { access: "blocked", blockedBecause: "external_effect" }
  }
] satisfies NonNullable<MossModuleManifest["routes"]>;
export const recordingIdentityFeature = {
  id: "meetings.recording_identity",
  description:
    "Paste transcripts; infer title, type and personal/work while keeping user choices. Change type below the title; filter beside search. Brain dumps group ideas. Rewrite style follows the type; untyped recordings offer a style selector.",
  errors: [
    {
      code: "recording_invalid_input",
      class: "validation",
      description:
        "Provide a nonempty transcript up to 100,000 characters and a title up to 240 UTF-8 bytes."
    },
    {
      code: "recording_request_conflict",
      class: "validation",
      description:
        "This submission key belongs to different input. Review the saved recording before submitting a new entry."
    },
    {
      code: "recording_entry_failed",
      class: "transient",
      description:
        "The pasted transcript could not be saved. Keep it and retry the same submission."
    },
    {
      code: "recording_type_unavailable",
      class: "validation",
      description: "The type is no longer active. Refresh the list and choose an active type."
    },
    {
      code: "recording_revision_conflict",
      class: "transient",
      description: "The recording changed elsewhere. Review the current type and retry."
    },
    {
      code: "recording_unavailable",
      class: "transient",
      description: "The recording could not be confirmed. Retry the same submission."
    },
    {
      code: "recording_queue_unavailable",
      class: "transient",
      description:
        "Recording analysis is unavailable. Retry adding the recording when the service recovers."
    }
  ],
  remediations: [
    {
      id: "meetings.retry_recording_identity",
      path: "/meetings",
      description:
        "Keep the submitted transcript while retrying. For retained recordings with failed analysis, open Meeting actions → Rewrite summary after configuring the default model in Settings → AI providers."
    }
  ]
} satisfies NonNullable<MossModuleManifest["features"]>[number];

export const recordingTypeConfigurationFeature = {
  id: "meetings.recording_type_configuration",
  description:
    "Edit recording types, descriptions and summary styles through chat approval. Retire or restore types without losing old identity or history filters. Limit: 32 retained types and bounded total description space, including retired entries.",
  errors: [
    {
      code: "recording_type_configuration_invalid",
      class: "validation",
      description:
        "Keep all existing IDs, unique names up to 80 characters, nonempty descriptions up to 500, a supported summary style and at least one active type. Retire old types; add new types as active."
    },
    {
      code: "recording_type_configuration_conflict",
      class: "transient",
      description:
        "Recording types changed elsewhere. Ask Moss to read the current list and propose the edit again."
    },
    {
      code: "recording_type_limit",
      class: "validation",
      description:
        "The limit is 32 total types, including retired types. Restore or edit an existing type; retirement does not free a slot."
    },
    {
      code: "recording_type_configuration_too_large",
      class: "validation",
      description:
        "The complete configuration is too large. Shorten names or descriptions; retired entries still consume space."
    }
  ],
  remediations: [
    {
      id: "meetings.edit_recording_types",
      path: "/meetings",
      description:
        "Ask in chat to edit or restore recording types and summary styles. Review before/after fields before approval. Read the latest list after a conflict. Shorten descriptions for size errors; retired types still count toward the 32-type limit."
    }
  ]
} satisfies NonNullable<MossModuleManifest["features"]>[number];
