import type { MossModuleManifest } from "@moss/module-sdk";

export const recordingDeliveryRoutes = [
  ...(
    [
      ["POST", ""],
      ["GET", "/:id"],
      ["PUT", "/:id/:kind/:index"],
      ["POST", "/:id/finalize"]
    ] as const
  ).map(([method, suffix]) => ({
    method,
    path: `/api/meetings/recording-uploads${suffix}`,
    permissionId: method === "GET" ? "meetings.read" : "meetings.write",
    chat: { access: "blocked" as const, blockedBecause: "external_effect" as const }
  })),
  {
    method: "POST",
    path: "/api/meetings/voice-recordings/:id/retry",
    permissionId: "meetings.write",
    chat: { access: "blocked", blockedBecause: "external_effect" }
  },
  {
    method: "POST",
    path: "/api/meetings/voice-enablement",
    permissionId: "meetings.write",
    chat: { access: "blocked", blockedBecause: "external_effect" }
  },
  {
    method: "POST",
    path: "/api/meetings/voice-enablement/:id/disable",
    permissionId: "meetings.write",
    chat: { access: "blocked", blockedBecause: "external_effect" }
  },
  {
    method: "POST",
    path: "/api/meetings/voice-recordings",
    permissionId: "meetings.write",
    chat: { access: "blocked", blockedBecause: "external_effect" }
  },
  {
    method: "GET",
    path: "/api/meetings/voice-recordings/:id",
    permissionId: "meetings.read",
    chat: { access: "blocked", blockedBecause: "external_effect" }
  },
  {
    method: "POST",
    path: "/api/meetings/recording-imports",
    permissionId: "meetings.write",
    chat: { access: "blocked", blockedBecause: "external_effect" }
  },
  {
    method: "GET",
    path: "/api/meetings/recording-imports/:id",
    permissionId: "meetings.read",
    chat: { access: "blocked", blockedBecause: "external_effect" }
  }
] satisfies NonNullable<MossModuleManifest["routes"]>;

export const recordingUploadFeature = {
  id: "meetings.resumable_recordings",
  description:
    "Android connects owned rings; uploads resume for 24 hours. Meetings up to two hours transcribe in windows. Segment ends may exceed audio by 500 ms and are clamped; larger drift fails with evidence retained. Hold: 120 seconds, sent to Main.",
  errors: [
    {
      code: "recording_import_conflict",
      class: "validation",
      description:
        "Restore the original manifest and bytes. A reserved recording cannot change owner, source or destination."
    },
    {
      code: "recording_import_invalid",
      class: "validation",
      description:
        "Use canonical audio, a complete sidecar and matching SHA256 hashes. Chunks are at most 1 MiB. Ring clock times and declared duration are kept as reported and never refuse audio; bookmarks outside the audio are dropped."
    }
  ]
} satisfies NonNullable<MossModuleManifest["features"]>[number];

export const recordingVoiceFeature = {
  id: "meetings.voice_recordings",
  remediations: [
    {
      id: "meetings.voice_developer_setup",
      path: "/settings?section=modules&module=meetings",
      description:
        "Enable Meetings in settings. The versioned receiver is a developer API; companion enablement and inventory snapshots are documented in apps/vocci-delivery/README.md."
    }
  ],
  description:
    "Opted-in hold audio enters normal Main chat automatically after transcription, including uncertain timing. Legacy requests keep their prior confirmation policy; baseline inventory stays Meetings evidence. Maximum 120 seconds.",
  errors: [
    {
      code: "recording_voice_ineligible",
      class: "prerequisite",
      remediationRef: "meetings.voice_developer_setup",
      description:
        "Enable hold-to-talk with a complete ring inventory first. Older hold recordings already on the ring are not imported."
    }
  ]
} satisfies NonNullable<MossModuleManifest["features"]>[number];

export const recordingImportFeature = {
  id: "meetings.recording_imports",
  remediations: [
    {
      id: "meetings.restore_import_access",
      path: "/settings?section=modules&module=meetings",
      description:
        "Restore Meetings access and configure transcription in Settings → AI providers before a new import."
    }
  ],
  description:
    "Imports retain source bytes, hashes, WAV, bookmarks and normal/voice-request mode. Transcripts appear in Meetings history. Uploaded voice requests start sooner. Legacy limit: 120 seconds; Android resumes longer uploads.",
  errors: [
    {
      code: "recording_import_invalid",
      class: "validation",
      description:
        "Use matching legacy filenames, valid hashes and canonical 16 kHz mono PCM WAV. Maximum body 8 MiB, packets 1 MiB, sidecar 64 KiB, audio 120 seconds."
    },
    {
      code: "recording_import_conflict",
      class: "validation",
      description:
        "This device and recording identity already has different evidence. Retained evidence is immutable; restore the original bundle."
    },
    {
      code: "transcription_unavailable",
      class: "prerequisite",
      remediationRef: "meetings.restore_import_access",
      description:
        "Configure transcription in Settings → AI providers before importing. A replay does not restart failed work."
    },
    {
      code: "transcription_failed",
      class: "transient",
      description:
        "Transcription failed after bounded attempts. Original evidence remains retained; status is available from the developer import endpoint."
    },
    {
      code: "import_interrupted",
      class: "transient",
      description: "Upload publication was interrupted and its abandoned vault files were removed."
    },
    {
      code: "import_unavailable",
      class: "prerequisite",
      remediationRef: "meetings.restore_import_access",
      description:
        "Access, Meetings availability or transcription configuration changed. Restore access and inspect retained import status."
    }
  ]
} satisfies NonNullable<MossModuleManifest["features"]>[number];
