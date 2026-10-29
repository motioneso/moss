import type { MossModuleManifest } from "@moss/module-sdk";

export const managedDeletionFeature = {
  id: "settings.recording_cleanup",
  description:
    "Account deletion cleans recording notes and memories first. Incomplete or changed notes retain the account and sessions for a confirmed retry. Administrators receive status only.",
  errors: [
    {
      code: "managed_cleanup_pending",
      class: "transient",
      description:
        "Recording cleanup is incomplete or its notes folder is unavailable. Confirm deletion again to continue after restoring the folder."
    },
    {
      code: "managed_cleanup_conflict",
      class: "validation",
      description:
        "A recording contribution changed. The owner must review its note before another confirmed deletion request."
    }
  ],
  remediations: [
    {
      id: "settings.review_recording_cleanup",
      path: "/meetings",
      description:
        "Review the recording and its current note. Preserve unrelated text and resolve the changed contribution before confirming account deletion again."
    },
    {
      id: "settings.retry_account_cleanup",
      path: "/settings?section=profile",
      description:
        "Restore unavailable note folders, then confirm account deletion again. Nothing deletes the account later in the background."
    }
  ]
} satisfies NonNullable<MossModuleManifest["features"]>[number];
