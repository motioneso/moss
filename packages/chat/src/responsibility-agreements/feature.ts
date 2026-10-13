import type { ModuleFeatureManifest } from "@moss/module-sdk";
export const responsibilityAgreementFeature = {
  id: "chat.bounded_action_agreements",
  featureFlagId: "chat.module",
  description:
    "With a configured JSON model and currently available Tasks status-change capability, in Main chat ask to mark one owned task done at a future relative time. Moss asks once in ordinary text. Typed yes saves the exact agreement under Settings, Scheduled tasks, Approved changes - not active. These records cannot run or resume; scheduled writes and action-scope editing are unavailable.",
  errors: [
    {
      code: "bounded_action_model_unavailable",
      class: "prerequisite",
      remediationRef: "chat.configure_agreement_model",
      description:
        "Without a configured JSON model, nothing is saved. Configure the model in AI providers and ask again."
    },
    {
      code: "bounded_action_capability_unavailable",
      class: "prerequisite",
      remediationRef: "chat.restore_agreement_capability",
      description:
        "An unavailable Tasks status-change capability prevents proposal and acceptance. Restore access and ask again; saved agreements grant no capability."
    },
    {
      code: "bounded_action_scope_refused",
      class: "validation",
      description:
        "Deletion, broader actions, repeats, changed scope and unclear replies save no agreement. Name one owned task and a future relative time, then answer the current question yes or no."
    },
    {
      code: "bounded_action_scope_stale",
      class: "validation",
      description:
        "Changed, expired or replaced proposals cannot be approved. Ask again for current terms. Declining saves no agreement."
    },
    {
      code: "bounded_action_not_active",
      class: "prerequisite",
      description:
        "Saved action agreements are not scheduled tasks. No change runs and no Resume control exists. Timing, pause/resume and task delivery controls do not activate these agreements."
    }
  ],
  remediations: [
    {
      id: "chat.configure_agreement_model",
      description: "Configure an available JSON model for Chat, then ask again.",
      path: "/settings?section=aiproviders"
    },
    {
      id: "chat.restore_agreement_capability",
      description:
        "Restore the currently available Tasks status-change capability, then request a fresh agreement.",
      path: "/settings?section=modules"
    }
  ]
} satisfies ModuleFeatureManifest;
