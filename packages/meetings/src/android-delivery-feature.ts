import type { MossModuleManifest } from "@moss/module-sdk";

export const androidDeliveryFeature = {
  id: "meetings.android_delivery",
  description:
    "Android ring delivery; separate Main hold opt-in. Ring storage: stopped refresh, source inspection and durable owner/source exclusions. Current requests may finish; evidence stays. No undo or ring deletion. Meetings: 2h; voice: 120s.",
  remediations: [
    {
      id: "meetings.android_developer_setup",
      path: "/settings?section=modules&module=meetings",
      description:
        "Fresh Android installs show Set up your ring. Choose another ring before Verify keeps Moss connected and repeats Vocci lookup. Configured installs keep setup. See apps/vocci-delivery/README.md. Meetings settings enable the receiver only."
    }
  ],
  errors: [
    {
      code: "recording_identity_change",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Saved recording management belongs to a different origin, owner, ring or source journal. Restore the original setup; neither exclusions nor queued audio are reassigned."
    },
    {
      code: "source_changed",
      class: "validation",
      description:
        "The selected source or advertised file sizes changed before exclusion. Refresh Ring storage, inspect the source and confirm again. No exclusion was saved."
    },
    {
      code: "exclusion_limit",
      class: "validation",
      description:
        "The bounded exclusion ledger has 1024 sources. No additional exclusion was saved; existing exclusions and recordings are retained."
    },
    {
      code: "ring_unavailable",
      class: "transient",
      description:
        "Ring storage refresh failed. Check Nearby devices, Bluetooth, competing Vocci access and the saved ring account, then explicitly refresh again. Prior inventory stays dated; delivery remains stopped if it was stopped."
    },
    {
      code: "configuration_or_storage_required",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Complete setup for an already-owned ring: browser-approved Moss link, native Vocci sign-in, explicit ring selection and physical identity/key verification. Writable app-private storage and Android Keystore are required."
    },
    {
      code: "setup_cleanup_required",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Reconnect and Cancel setup to finish pending cleanup. Offline sign-out is unconfirmed. A saved verified Vocci session offers Finish ring lookup. Opening setup sends no email automatically."
    },
    {
      code: "setup_ownership_unsupported",
      class: "prerequisite",
      remediationRef: "meetings.android_developer_setup",
      description:
        "Use an already-owned ring and native email-code sign-in, with an authenticator code if required. Missing rings, unsupported methods or invalid binding details need legitimate recovery in Vocci. No ownership reset is attempted."
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
