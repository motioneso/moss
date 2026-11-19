import type { CoreAppErrorDeclaration, CoreAppRemediationDeclaration } from "./app-map-core.js";

export const RUST_CHAT_ERRORS: readonly CoreAppErrorDeclaration[] = [
  {
    code: "rust-chat-approval-timed-out",
    runtime: "rust",
    class: "transient",
    remediationRef: "rust-chat-ask-again",
    description: "The approval card timed out before you answered. The action did not run."
  },
  {
    code: "rust-chat-approval-unavailable",
    runtime: "rust",
    class: "transient",
    remediationRef: "rust-chat-ask-again",
    description: "This approval is no longer available. Ask Moss for a new card."
  }
];

export const RUST_CHAT_REMEDIATIONS: readonly CoreAppRemediationDeclaration[] = [
  {
    id: "rust-chat-ask-again",
    runtime: "rust",
    path: "/",
    scope: "user",
    description: "Ask Moss again and review the new approval card before approving."
  }
];
