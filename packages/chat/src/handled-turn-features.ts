import type { MossModuleManifest } from "@moss/module-sdk";

import { approvalFeatures } from "./approval-features.js";

export const handledTurnFeatures = [
  {
    id: "chat.handled_turn_activity",
    description:
      "Main chat only. When the fast model answers a message itself, Settings > Activity shows one line with that model, the tool it ran and the time taken. Private chats and attachments skip it.",
    featureFlagId: "chat.module"
  },
  {
    id: "chat.front_door_personal_switch",
    description:
      "Settings > Your assistant > Fast model. Each account can turn the fast model off for itself and choose whether locks and doors are offered. The admin cannot read or change it. A failed read counts as off.",
    featureFlagId: "chat.module"
  }
] satisfies NonNullable<MossModuleManifest["features"]>;

/** Approval and handled-turn entries, spread into the chat manifest as one group. */
export const approvalAndHandledTurnFeatures = [...approvalFeatures, ...handledTurnFeatures];
