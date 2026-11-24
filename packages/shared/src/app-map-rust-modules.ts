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
    id: "rust-module-update-service",
    runtime: "rust",
    description:
      "An instance administrator can review an installed registry module through POST /api/modules/update-review, then approve its saved operation through POST /api/modules/{module}/update. Even urgent offers wait for capability and migration approval. Execution refuses changed package bytes or a changed installed digest and leaves the previous module usable when activation fails. POST /api/modules/{module}/skip records the exact offered digest; later digests remain eligible. POST /api/modules/{module}/pin pins the installed version or lifts its pin with a null version. Pins prevent updates until lifted. Both choices survive restart and appear as pin and skippedDigest in the catalog alongside the urgent marker. The session supplies the actor; these configuration powers grant no access to another account's private data. These APIs add no screens."
  },
  {
    moduleId: "core",
    id: "rust-module-policy-service",
    runtime: "rust",
    description:
      "The signed-in account reads or changes its own module switch at GET or POST /api/modules/{module}/account-switch with enabled. An instance administrator separately controls POST /api/modules/{module}/server-switch. Server off stops every account; turning it on preserves each account's saved choice. The account projection returns enabled, onForEveryone, blocked and digest, so future screens can show the On for everyone badge independently. GET or POST /api/modules/policy persists the administrator's automatic and quietTime choices. Automatic updates default on, but ordinary updates wait for quiet-time eligibility, which defaults off. Pins, skipped offers, permission growth and new migrations still stop automatic activation, including urgent permission growth. Startup, daily checks and opening the module catalog refresh configured sources through the existing signed client; catalog rendering uses saved metadata instead of fetching again. Concurrent refresh requests share an in-flight pass. POST /api/modules/refresh lets an administrator request the same refresh. Payload account fields are refused; the session supplies every request actor. No switch or policy management screens ship in this part."
  },
  {
    moduleId: "core",
    id: "rust-module-lifecycle-service",
    runtime: "rust",
    description:
      "The authenticated Rust management API accepts remove and typed remove-and-delete-data at POST /api/modules/remove, lists snapshot metadata at GET /api/modules/snapshots and restores at POST /api/modules/restore. Remove keeps every account's rows, key-value data, files and credentials for reinstallation. Deleting data first takes a snapshot of every account's module data, kept for 30 days; a wrong typed module name refuses before changing that data. Restore requires the module name and acknowledgement that newer writes will be lost. Expired snapshots refuse with a plain reason, including after restart. GET /api/modules/operations/{id} returns the signed-in administrator's saved result and recovers interrupted changes through the migration service. POST /api/modules/operations/{id}/cancel cancels queued lifecycle work; an operation already changing data refuses cancellation and completes or recovers safely. Administrator power manages configuration and never grants access to other accounts' private rows or another builder's private local module. These endpoints support later screens; no lifecycle screens are shipped here."
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
    id: "core.modules.policy_refused",
    runtime: "rust",
    description:
      "If modules are still starting, wait and try again. If a switch or policy cannot be read or saved, check that the module is installed and permits account switching. Use your own signed-in account for its switch, or sign in as an instance administrator for server controls and update policy. Private local modules have no server switch. A failed registry refresh retains installed modules and saved signed metadata; check its configured source and retry.",
    path: "/settings?section=instmods",
    scope: "user"
  },
  {
    id: "core.modules.update_choice_refused",
    runtime: "rust",
    description:
      "A missing installed module, mismatched review, unapproved update, stale digest, invalid pin or unavailable source refuses the update choice. Sign in as an instance administrator, check the saved operation and current catalog, obtain a fresh review and approve it. Lift a pin before updating; pin only the installed version. A failed update retains the previous digest: check it before trying again. Payload account fields are refused; use the signed-in account.",
    path: "/sign-in",
    scope: "admin"
  },
  {
    id: "core.modules.lifecycle_result",
    runtime: "rust",
    description:
      "Read the saved operation result before retrying removal or restore. Type the exact module name for deletion, or confirm the name and loss of newer writes for restore. Choose a current snapshot when one expired or is unavailable. Remove dependent modules first when removal is refused. A running change cannot be cancelled: let it finish and read its result; a restart recovers interrupted data changes before reporting the outcome.",
    path: "/sign-in",
    scope: "admin"
  },

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
