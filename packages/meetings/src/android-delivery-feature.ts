import type { MossModuleManifest } from "@moss/module-sdk";

export const androidDeliveryFeature = {
  id: "meetings.android_delivery",
  description:
    "Android browser linking, restart recovery and optional seven-day cleanup. Only Start enables recovery; stopped voice/cleanup/retry actions ask for Start. Meetings: two hours; voice: 120 seconds. Fresh installs offer browser-approved Moss linking, native Vocci email-code sign-in, owned-ring selection and physical verification. Continue to the companion and explicitly Start; hold opt-in remains on that screen. Factory-fresh ownership and unsupported sign-in methods need Vocci.",
  remediations: [
    {
      id: "meetings.android_developer_setup",
      path: "/settings?section=modules&module=meetings",
      description:
        "Open the Android companion for account linking, permissions and local audio. Fresh installs open Set up your ring; existing configured installs keep their saved setup. Guidance and pre-release acceptance limits are documented in apps/vocci-delivery/README.md. Meetings settings enable the receiver only."
    }
  ],
  errors: [
    {
      code: "configuration_or_storage_required",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Complete guided setup for an already-owned ring and provide writable app-private storage before delivery. Approve Moss in your browser, enter the Vocci email code only in the app, select an owned ring and Verify ring. Configuration is published only after physical identity/key and fresh Moss-owner checks. Credentials use Android Keystore encryption."
    },
    {
      code: "setup_cleanup_required",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Interrupted setup retains encrypted cleanup material. Reconnect and Cancel setup; do not claim remote sign-out while offline. A saved verified Vocci session offers Finish ring lookup. Opening setup sends no email automatically."
    },
    {
      code: "setup_ownership_unsupported",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Only already-owned rings with supported native email-code sign-in and required authenticator codes are supported. No rings, unsupported factors or malformed/ambiguous binding details require legitimate account recovery or ownership setup in Vocci. No reset or ownership write is attempted."
    },
    {
      code: "background_restart_required",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Start enables boot/app-update recovery; Stop disables it. After Force stop, launch and Start manually. Expand Permissions and background settings for battery controls; choose Unrestricted and remove Moss from Samsung Sleeping apps."
    },
    {
      code: "owner_mismatch",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Delivery stops if the live Moss session belongs to another owner. Reconnect the original owner in the browser; changing the queued source identity is not a recovery step."
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
        "Connect Moss in browser from the Android companion using the original account, then Start delivery. Device approval expires after 90 inactive days or one year; pending evidence stays on Android."
    },
    {
      code: "server_identity_change",
      class: "validation",
      description:
        "A receiver or chat identity changed. Delivery stops for that recording and retains its frozen evidence."
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
        "Moss permanently rejected a request. Delivery is blocked, or the affected recording failed. Inspect the companion connection status before restarting; retain source identity."
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
        "The stable advertised recording exceeds 32 MiB of packets or 256 KiB of sidecar. It fails visibly without downloading oversized files; other recordings continue."
    },
    {
      code: "duration_limit",
      class: "validation",
      description:
        "The completed sidecar exceeds two hours for a meeting or 120 seconds for opted-in hold input. The sidecar stays retained without downloading its audio."
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
        "Android reserves source/decode budgets within 2 GiB and keeps 150 MiB free. Retrieval also pauses at 100 retained items or 1024 identities. Clear completed local audio; queued and failed evidence stays retained."
    }
  ]
} satisfies NonNullable<MossModuleManifest["features"]>[number];
