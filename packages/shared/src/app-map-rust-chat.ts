import type { CoreAppRemediationDeclaration } from "./app-map-core.js";

// Approval failures are card states and HTTP statuses, not emitted error codes.
// CORE_APP_FEATURES describes them; keep only their retry action here.
export const RUST_CHAT_REMEDIATIONS: readonly CoreAppRemediationDeclaration[] = [
  {
    id: "rust-chat-ask-again",
    runtime: "rust",
    path: "/",
    scope: "user",
    description: "Ask Moss again and review the new approval card before approving."
  }
];
