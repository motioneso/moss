import type { MossModuleManifest } from "@moss/module-sdk";

export const userDataVisualFeature = {
  id: "chat.user_data_visuals",
  description:
    "Saved Main/side chats can show three supplied facts as Your data (unverified), after save and reload. Copy/export retain text. Private/meeting/text-only replies stay prose. Needs connected chat tools. No lookups or controls.",
  errors: [
    {
      code: "visual_unavailable",
      class: "transient",
      description:
        "A rejected, incompatible or failed visual keeps the ordinary answer and available readable facts. Read or copy the text, or ask for a text-only answer."
    }
  ],
  remediations: [
    {
      id: "chat.visual_use_text",
      description: "Read or copy the text, or ask Moss for a text-only answer.",
      path: "/today"
    }
  ],
  featureFlagId: "chat.module"
} satisfies NonNullable<MossModuleManifest["features"]>[number];
