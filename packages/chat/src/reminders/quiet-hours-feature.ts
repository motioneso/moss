import type { ModuleFeatureManifest } from "@moss/module-sdk";

export const quietHoursAllowanceFeature: ModuleFeatureManifest = {
  id: "chat.reminder_quiet_hours_allowance",
  description:
    "Save or remove one reminder's quiet-hours allowance in Main chat. Exact names act; partial names need typed yes; duplicate names need an ID. Choices are saved; delivery support is pending.",
  featureFlagId: "chat.module",
  errors: [
    {
      code: "reminder_allowance_target_unclear",
      class: "validation",
      description:
        "Name one owned reminder, or use its ID when titles match. Nothing is saved until the target and typed agreement are clear."
    }
  ]
};
