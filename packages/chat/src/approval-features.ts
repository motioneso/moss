import type { MossModuleManifest } from "@moss/module-sdk";

export const approvalFeatures = [
  {
    id: "chat.first_turn_approval",
    description:
      "The first request in a new account binds its approval card to the owner's Main conversation."
  },
  {
    id: "chat.pending_action_disclosure",
    description:
      "App cards show exact server targets and human-readable changes. Memory and note deletion use red Approve. " +
      "Native permissions keep exact commands or paths. Missing details keep Reject only. Outside content adds one notice.",
    errors: [
      {
        code: "invalid_input",
        class: "validation",
        description:
          "Invalid fields or impossible target changes return a correction before approval; nothing executes. The quiet row says details need correcting. Extra-field errors identify safe field names, never values. Correct the fields and ask again."
      },
      {
        code: "approval_setup_required",
        class: "prerequisite",
        remediationRef: "chat.configure_action_source",
        description:
          "Required setup is missing before this action can be prepared. Follow its safe prerequisite reason; notes need a linked folder in Settings, Connections."
      },
      {
        code: "approval_preparation_failed",
        class: "transient",
        description:
          "An unexpected error prevented the app or connected tool from preparing this action. Try again; private dependency details stay hidden. This does not mean setup is missing."
      },
      {
        code: "approval_unavailable",
        class: "prerequisite",
        description: "Complete server details are unavailable, so this request cannot be approved.",
        remediationRef: "chat.request_fresh_action"
      }
    ],
    remediations: [
      {
        id: "chat.configure_action_source",
        description:
          "Review the source or connection setup in Settings, Connections. Choose a notes folder if none is linked.",
        path: "/settings?section=sources"
      },
      {
        id: "chat.request_fresh_action",
        description: "Reject the request and ask Moss to find the action again.",
        path: "/today"
      }
    ],
    featureFlagId: "chat.module"
  }
] satisfies NonNullable<MossModuleManifest["features"]>;
