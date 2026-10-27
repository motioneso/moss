import type { MossModuleManifest } from "@moss/module-sdk";
export const recordingIdentityRoutes = [
  {
    method: "GET",
    path: "/api/meetings/recording-types",
    permissionId: "meetings.read",
    chat: { access: "read" }
  },
  {
    method: "GET",
    path: "/api/meetings/records/:id/recording",
    permissionId: "meetings.read",
    chat: { access: "read" }
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
    "Add recording accepts pasted transcripts without a Mac. Your summary model chooses title, type and personal/work label, keeping user choices. Change type below the title; filter beside search. Brain dumps show grouped ideas.",
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
      remediationRef: "meetings.retry_recording_identity",
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
