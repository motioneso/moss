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
    id: "rust-module-runtime-revocation",
    runtime: "rust",
    description:
      "The Rust module host remembers registry warnings and blocks with their source, target and reason. A block stops the affected package for every account, including routes, chat tools, queued work and module frames; a warning keeps it running. Cached blocks apply before the host serves after an offline restart. Omitting a revocation or changing a block to a warning cannot lift it. A registry root may lift its revocation, but cannot turn a module back on after an administrator switched it off. The host keeps a policy activity journal containing metadata only. These are host service behaviors for future module screens."
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
    id: "core.modules.registry_revocation",
    description:
      "The host saves the registry reason for future module screens. A blocked package needs a registry root-signed lift or an approved replacement package; refreshing an index that omits the block cannot clear it. An administrator's separate switch stays off after a registry lift.",
    path: "/settings?section=instmods",
    scope: "admin"
  },
  {
    id: "core.modules.review_package_again",
    description:
      "Check the saved operation result and registry configuration. An instance administrator must obtain and approve a fresh review before trying a failed installation again.",
    path: "/settings?section=instmods",
    scope: "admin"
  }
];
