import type { MossModuleManifest } from "@moss/module-sdk";

export const androidDeliveryFeature = {
  id: "meetings.android_delivery",
  description:
    "A developer-installed Android foreground client retrieves completed Vocci recordings after an explicit Bluetooth-permission handoff. Delivery retries retain identity and source evidence. No consumer onboarding; maximum 120 seconds.",
  remediations: [
    {
      id: "meetings.android_developer_setup",
      path: "/settings?section=modules&module=meetings",
      description:
        "Meetings settings enable the receiver only. For Android permission handoff, session refresh or local storage, use apps/vocci-delivery/README.md in the source checkout and restart the developer client."
    }
  ],
  errors: [
    {
      code: "configuration_or_storage_required",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Developer provisioning and writable app-private storage are required before delivery can start. Credentials use Android Keystore encryption."
    },
    {
      code: "owner_mismatch",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Delivery stops if the live Moss session belongs to another owner. Refresh the original owner's session; changing the queued source identity is not a recovery step."
    },
    {
      code: "handoff_required",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Relinquish Vocci's Nearby devices permission in Android settings before starting delivery. Restore its previous permission when returning control to Vocci."
    },
    {
      code: "session_refresh_required",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Developer provisioning must refresh the same owner's Moss session and restart delivery. Pending evidence remains on Android."
    },
    {
      code: "retry_pending",
      class: "transient",
      description:
        "The ring connection retries automatically with increasing delays, capped at 30 minutes. Keep the ring and Bluetooth available. No ring files are deleted."
    },
    {
      code: "server_unavailable",
      class: "transient",
      description:
        "The Moss session endpoint is unavailable. Delivery retries with backoff; a session rejection requires same-owner refresh and restart."
    },
    {
      code: "server_rejected",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Moss permanently rejected a request. Delivery is blocked, or the affected recording failed. Inspect the developer setup before restarting; retain source identity."
    },
    {
      code: "retry_exhausted",
      class: "validation",
      description:
        "Eight interrupted upload attempts exhausted the automatic retry budget. The failed recording and frozen evidence remain private on Android."
    },
    {
      code: "transfer_retry",
      class: "transient",
      description:
        "A temporary upload or processing-status read failed. Delivery retains its identity and retries with backoff, up to eight attempts."
    },
    {
      code: "source_size_limit",
      class: "validation",
      description:
        "The stable advertised recording exceeds 1 MiB of packets or 64 KiB of sidecar. It fails visibly without downloading oversized files; other recordings continue."
    },
    {
      code: "duration_limit",
      class: "validation",
      description:
        "The completed sidecar reports more than 120 seconds. The recording fails visibly with that sidecar retained, without downloading its audio."
    },
    {
      code: "server_identity_change",
      class: "validation",
      description:
        "The server returned a different import or meeting identity. This recording fails visibly; its source identity and frozen evidence stay unchanged."
    },
    {
      code: "server_mode_change",
      class: "validation",
      description:
        "The returned normal or voice-request mode differs from the source filename. This recording fails visibly and retains its evidence."
    },
    {
      code: "sidecar_invalid",
      class: "validation",
      description:
        "A stable sidecar has invalid JSON or ends without a positive finite duration. It fails locally with its sidecar retained; other recordings continue."
    },
    {
      code: "ring_file_invalid",
      class: "validation",
      description:
        "A read violated framing or size. Healthy sources go first on reconnect; the faulty source restarts with backoff and fails after eight attempts."
    },
    {
      code: "decode_or_input_invalid",
      class: "validation",
      description:
        "A retained recording has invalid packet continuity, codec output or duration. It fails locally and other recordings continue."
    },
    {
      code: "storage_capacity",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Android retrieval pauses at 100 retained recordings or 100 MiB, or with less than 150 MiB free space. Developer retention management is required."
    }
  ]
} satisfies NonNullable<MossModuleManifest["features"]>[number];
