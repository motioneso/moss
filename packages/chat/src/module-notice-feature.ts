export const MODULE_NOTICE_FEATURE = {
  id: "chat.module_notices",
  description:
    "Participating modules save source-linked notices once in Main. History retains them across reconnects, and pending notices survive delivery retries. Referenced actions use their normal review and approval.",
  featureFlagId: "chat.module",
  errors: [
    {
      code: "no_main",
      class: "prerequisite",
      remediationRef: "chat.open_main_for_notices",
      description: "A notice cannot be delivered while Main is unavailable."
    }
  ],
  remediations: [
    {
      id: "chat.open_main_for_notices",
      path: "/chat",
      description:
        "Open Main and send a message if it is empty, then reload. Pending notices recover when Main refreshes."
    }
  ]
} as const;
