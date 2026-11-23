import type { AppMapItem, CoreAppRemediationDeclaration } from "./app-map-core.js";

export const RUST_MODULE_FEATURES: readonly (AppMapItem & {
  readonly id: string;
  readonly description: string;
})[] = [
  {
    moduleId: "core",
    id: "rust-module-management-service",
    runtime: "rust",
    description:
      "The module management service lists signed sources separately and lets an instance administrator review an exact package before installation. The saved review includes its source, version, digest, capabilities and migrations. Installing checks administrator permission and the reviewed package again. A saved operation reports checking, installing, success or failure and survives a server restart; repeating a completed operation returns its saved result. Source changes or changed package bytes require a fresh review. These are service contracts for future module screens; the existing module screens are unchanged."
  },
  {
    moduleId: "core",
    id: "rust-module-chat",
    runtime: "rust",
    description:
      "Moss can use the chat tools of modules you have installed and switched on for your account. Tools with a declared input schema are available. Scratchpad can read your private note through chat. Commitments can list suggestions and show their evidence. Chat asks before deleting, sending outside your account, or pinned actions; approve or reject the card in the chat drawer. After you approve a card, Moss is told you approved it, and when a setting lets an action run without a card it is told that too, so it never says no approval was needed. Agent tool permissions also show a card. Outcomes say Approved, You declined or Timed out. If approval timed out or is no longer available, ask Moss again. Plain writes run unless you chose to ask first, and show Done with the labelled before and after values from the tool. Codex keeps its starting tool list until a fresh conversation."
  }
];

// Management failures are HTTP statuses and saved result messages, not emitted error codes.
export const RUST_MODULE_REMEDIATIONS: readonly CoreAppRemediationDeclaration[] = [
  {
    id: "core.modules.review_package_again",
    description:
      "Check the saved operation result and registry configuration. An instance administrator must obtain and approve a fresh review before trying a failed installation again.",
    path: "/settings?section=instmods",
    scope: "admin"
  }
];
