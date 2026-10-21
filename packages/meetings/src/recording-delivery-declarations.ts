import type { MossModuleManifest } from "@moss/module-sdk";

export const recordingDeliveryRoutes = [
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
    "Opted-in hold recordings retain audio and enter Main after transcription. Stable inventory and old queued files stay Meetings evidence. Android uses explicit Send for unobserved capture timing. Maximum 120 seconds.",
  errors: [
    {
      code: "recording_voice_ineligible",
      class: "prerequisite",
      remediationRef: "meetings.voice_developer_setup",
      description:
        "Enable hold-to-talk with a complete ring inventory first. Baseline recordings remain meeting imports."
    }
  ]
} satisfies NonNullable<MossModuleManifest["features"]>[number];
