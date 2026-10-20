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
        "Use the developer Android setup instructions to restore the permission handoff, same-owner session or local storage, then restart the installed delivery client."
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
      code: "reconnect_exhausted",
      class: "transient",
      description:
        "After eight unsuccessful sessions, restart delivery when the ring and Bluetooth are available. No ring files are deleted."
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
