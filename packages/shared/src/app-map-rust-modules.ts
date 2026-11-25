import type {
  AppMapItem,
  CoreAppRemediationDeclaration,
  CoreAppSurfaceDeclaration,
  CoreAppErrorDeclaration
} from "./app-map-core.js";

export const RUST_MODULE_FEATURES: readonly (AppMapItem & {
  readonly id: string;
  readonly description: string;
})[] = [
  {
    moduleId: "core",
    id: "rust-module-trust-screens",
    runtime: "rust",
    description:
      "Registry settings show signed health and require an explicit Trust and add confirmation of the staged root fingerprint. Address or folder imports use the existing registry API; signed registry JSON envelopes import files and packages. POST /api/modules/local/review signs and validates the built package through the existing backend and returns exact digest, public fingerprint and permissions. POST /api/modules/local/install accepts only those signed bytes and explicit approval, using the session owner and existing builder-only install_local backend. Package manifests must declare a local.<signed-in account>.* ID, routes and owner-only capabilities. Another account, including an admin, cannot review or install that package. GET /api/modules/trust/{id} returns only an installed package visible to the session owner, with local provenance or saved block/warn details. Local signing secrets are not returned. Local packages stay out of portable lists and other accounts' screens."
  },
  {
    moduleId: "core",
    id: "rust-module-catalog-view",
    runtime: "rust",
    description:
      "GET /api/modules/catalog-view is a read-only session-scoped member projection of verified signed catalogs and visible installed records. It includes only the signed-in account’s switch and user-scoped settings. Members receive no management projection, registry configuration, keys or other accounts’ state. Existing administrative endpoints remain protected. The header cog opens declared module settings paths, including paths outside /settings/. Unmatched paths keep the existing not-built screen. Administrators receive a separate management projection. Recent activity shows recorded registry notices and lifts, with local dates; install and update history is not recorded by this endpoint. Category and screenshot references are optional signed index metadata checked by the existing signature path. GET /api/modules/catalog-media/{source}/{file} serves only signed referenced image files after digest verification. No new signing or storage scheme is used."
  },
  {
    moduleId: "core",
    id: "rust-module-management-service",
    runtime: "rust",
    description:
      "The module management service lists signed sources separately and lets an instance administrator review an exact package before installation. The saved review includes its source, version, digest, capabilities and migrations. Installing checks administrator permission and the reviewed package again. A saved operation reports queued, checking, downloading, verifying, setting up data, activating, success or failure and survives a server restart; repeating a completed operation returns its saved result. Source changes or changed package bytes require a fresh review. The install review and result screens use the saved journal. A reload reads the same operation. Fixed failure messages distinguish download, package verification and data setup without exposing internal error details. Retry obtains a fresh review and requires explicit approval again."
  },
  {
    moduleId: "core",
    id: "rust-module-install-requests",
    runtime: "rust",
    description:
      "Signed-in accounts can submit a module and configured source to POST /api/modules/requests and read their own requests through GET /api/modules/requests or GET /api/modules/requests/{id}. The session supplies the account; payload account fields are refused. Repeating the same account, source and module returns the saved request, including after restart. Unavailable, expired, blocked or untrusted offers return a plain reason. Administrators can read request metadata and approve through POST /api/modules/requests/{id}/approve with their own saved install review. Approval reuses the existing digest-bound execution and operation result, and refuses mismatched modules or sources. This configuration authority never grants access to another account's private module data. Automatic admin notices are unsupported: the existing notification service targets only the triggering account. Responses explicitly report that limitation, and no substitute notification channel is added. Members selecting Install open Ask an admin, with saved status and Check status. The Installed screen displays pending requests clearly to administrators. Review opens exact package approval. POST /api/modules/requests/{id}/decline is administrator-only and records declinedBy and declinedAt; members see Declined. Approval refuses declined requests; decline refuses requests with an install operation."
  },
  {
    moduleId: "core",
    id: "rust-module-update-service",
    runtime: "rust",
    description:
      "An instance administrator can review an installed registry module through POST /api/modules/update-review, then approve its saved operation through POST /api/modules/{module}/update. Even urgent offers wait for capability and migration approval. Execution refuses changed package bytes or a changed installed digest and leaves the previous module usable when activation fails. POST /api/modules/{module}/skip records the exact offered digest; later digests remain eligible. POST /api/modules/{module}/pin pins the installed version or lifts its pin with a null version. Pins prevent updates until lifted. Both choices survive restart and appear as pin and skippedDigest in the catalog alongside the urgent marker. The session supplies the actor; these configuration powers grant no access to another account's private data. The update review screen shows only added permissions, urgent and data-update markers, changelog and versions. Update explicitly approves the saved review; Skip saves the offered digest. An update failure after data setup reports the restored version only when the host confirms the old activation and no pending recovery journal."
  },
  {
    moduleId: "core",
    id: "rust-module-policy-service",
    runtime: "rust",
    description:
      "The signed-in account reads or changes its own module switch at GET or POST /api/modules/{module}/account-switch with enabled. An instance administrator separately controls POST /api/modules/{module}/server-switch. Server off stops every account; turning it on preserves each account's saved choice. The account projection returns enabled, onForEveryone, blocked and digest, so future screens can show the On for everyone badge independently. GET or POST /api/modules/policy persists the administrator's automatic and quietTime choices. Automatic updates default on, but ordinary updates wait for quiet-time eligibility, which defaults off. Pins, skipped offers, permission growth and new migrations still stop automatic activation, including urgent permission growth. Startup, daily checks, opening the signed-in app shell and opening the module catalog refresh configured sources through the existing signed client; catalog rendering uses saved metadata instead of fetching again. Concurrent refresh requests share an in-flight pass. POST /api/modules/refresh lets an administrator request the same refresh. Payload account fields are refused; the session supplies every request actor. Installed rows expose the account switch; administrators separately open Server controls and the management header cog."
  },
  {
    moduleId: "core",
    id: "rust-module-lifecycle-service",
    runtime: "rust",
    description:
      "The authenticated Rust management API accepts remove and typed remove-and-delete-data at POST /api/modules/remove, lists snapshot metadata at GET /api/modules/snapshots and restores at POST /api/modules/restore. Remove keeps every account's rows, key-value data, files and credentials for reinstallation. Deleting data first takes a snapshot of every account's module data, kept for 30 days; a wrong typed module name refuses before changing that data. Restore requires the module name and acknowledgement that newer writes will be lost. Expired snapshots refuse with a plain reason, including after restart. GET /api/modules/operations/{id} returns the signed-in administrator's saved result and recovers interrupted changes through the migration service. POST /api/modules/operations/{id}/cancel cancels queued lifecycle work; an operation already changing data refuses cancellation and completes or recovers safely. Administrator power manages configuration and never grants access to other accounts' private rows or another builder's private local module. The Remove screen offers removal with data kept or typed-name deletion with an all-account, 30-day warning. The Restore screen lists snapshot dates, previous versions and availability; Restore snapshot confirms replacement of current module data for every account. Expired or empty snapshots cannot be restored. Both screens show the saved host result and read the same operation after reload."
  },

  {
    moduleId: "core",
    id: "rust-module-runtime-revocation",
    runtime: "rust",
    description:
      "The Rust module host remembers registry warnings and blocks with their source, target and reason. A block stops the affected package for every account, including routes, chat tools, queued work and module frames; a warning keeps it running. Cached blocks apply before the host serves after an offline restart. Omitting a revocation or changing a block to a warning cannot lift it. A registry root may lift its revocation, but cannot turn a module back on after an administrator switched it off. The host keeps a policy activity journal containing metadata only. Registry notice details show the saved reason, source, version, data kept and block or still-running status."
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
    id: "core.modules.registry_retry",
    runtime: "rust",
    scope: "admin",
    description:
      "Retry the registry read. For refused imports, check signed files, host first-party trust and root public key. Check the displayed fingerprint before Trust and add. An expired registry needs a fresh signed index; installed packages and cached blocks remain in effect.",
    path: "/settings/modules/registries"
  },
  {
    id: "core.modules.local_retry",
    runtime: "rust",
    scope: "user",
    description:
      "Use the builder's signed-in account and a package with its declared local account prefix. Check the package and unlock host key storage, then sign and review again. Another account, including an administrator, cannot access this package.",
    path: "/settings/modules/local"
  },
  {
    id: "core.modules.trust_retry",
    runtime: "rust",
    scope: "user",
    description:
      "Retry saved trust details as the package owner. A saved block remains effective offline; an administrator can check for a trusted replacement in module details. A warning keeps the module running. Missing private packages stay unavailable to other accounts.",
    path: "/settings/modules?module={module}&source={source}&screen=trust"
  },
  {
    id: "core.modules.request_retry",
    runtime: "rust",
    scope: "user",
    description:
      "Check status before retrying a request or decline. Only administrators can decline pending requests. Review and approve the exact module and source to install; a declined request cannot be approved.",
    path: "/settings/modules?module={module}&source={source}&screen=request"
  },
  {
    id: "core.modules.install_retry",
    runtime: "rust",
    scope: "admin",
    description:
      "Read the saved reason. Restore registry connectivity for a download failure or ask the administrator to repair module data setup, then Retry to review and approve the current package. Changed packages require a new review. For unavailable status, Retry reads the same journal instead of starting new work.",
    path: "/settings/modules?module={module}&source={source}&screen=install&operation={operation}"
  },
  {
    id: "core.modules.catalog_retry",
    runtime: "rust",
    description:
      "Use Retry after a catalog read fails. Offline sources retain verified cached records and installed modules. Missing or unreadable registry configuration shows a notice while installed modules remain usable. Ask an administrator to check the configured source if Retry keeps failing. A missing module may be private to another builder. Reopen details for unavailable settings or screenshots; a source must publish valid signed image metadata and matching bytes.",
    path: "/settings/modules",
    scope: "user"
  },
  {
    id: "core.modules.install_request_refused",
    runtime: "rust",
    description:
      "Sign in to submit or read your own install requests. A missing request may belong to another account. For an unavailable module, ask an administrator to check the configured source and signed current registry, then retry. A saved request is not an automatic admin notice: ask your administrator to read the requests. If the saved operation status is unavailable, ask the approving administrator to check that operation before retrying.",
    path: "/sign-in",
    scope: "user"
  },
  {
    id: "core.modules.install_request_approval_refused",
    runtime: "rust",
    description:
      "Only an instance administrator can approve an install request. Obtain your own fresh review for the request's exact module and source and explicitly approve it. While active or completed, retry with the request's saved operation. After failure, obtain a fresh review for changed bytes or registry configuration before approving again. Request status remains readable during installation.",
    path: "/sign-in",
    scope: "admin"
  },
  {
    id: "core.modules.policy_refused",
    runtime: "rust",
    description:
      "If modules are still starting, wait and try again. If a switch or policy cannot be read or saved, check that the module is installed and permits account switching. Use your own signed-in account for its switch, or sign in as an instance administrator for server controls and update policy. Private local modules have no server switch. A failed registry refresh retains installed modules and saved signed metadata; check its configured source and retry.",
    path: "/sign-in",
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
    path: "/settings/modules?module={module}&source={source}&screen=restore",
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

export const RUST_MODULE_SCREENS: readonly CoreAppSurfaceDeclaration[] = [
  {
    id: "rust-module-registries",
    runtime: "rust",
    label: "Registries",
    description:
      "Administrators open the Registries tab to see signed health, check an address or folder and explicitly confirm its root fingerprint before trust is saved. Signed registry files can be imported for review; unavailable or expired sources show their health.",
    path: "/settings/modules/registries",
    scope: "admin"
  },
  {
    id: "rust-module-local-package",
    runtime: "rust",
    label: "Local package",
    description:
      "The signed-in builder selects a built package, signs and reviews its digest, install fingerprint and permissions, then explicitly installs through the builder-only backend. Other accounts, including administrators, are refused.",
    path: "/settings/modules/local",
    scope: "user"
  },
  {
    id: "rust-module-trust-details",
    runtime: "rust",
    label: "Registry notice and local provenance",
    description:
      "Module details open saved blocked or warning reasons and sources, version, kept data and next step. Locally installed packages show Private to you, Signed on this server, Not registry-reviewed, digest and install key fingerprint, only to their builder.",
    path: "/settings/modules?module={module}&source={source}&screen=trust",
    scope: "user"
  },
  {
    id: "rust-module-update-review",
    runtime: "rust",
    label: "Update review",
    description:
      "Administrators open Review update from installed module details. The shared dialog shows signed source, old and new version, changelog, only added permissions, and urgent and new migration markers. Update approves the saved digest-bound operation. Skip persists the offered digest. Pin and Unpin remain on details. Reload reads the same review or result. Failed updates report confirmed snapshot restoration; Retry gets a fresh review.",
    path: "/settings/modules?module={module}&source={source}&screen=update",
    scope: "admin"
  },
  {
    id: "rust-module-remove",
    runtime: "rust",
    label: "Remove and delete module data",
    description:
      "Administrators open Remove from installed module details. Remove keeps data for reinstall. Remove and delete data requires the exact module name and warns about all accounts and 30-day snapshot retention. A mismatch disables deletion and is independently refused by the host. The saved result survives reload; refused changes offer Retry.",
    path: "/settings/modules?module={module}&source={source}&screen=remove",
    scope: "admin"
  },
  {
    id: "rust-module-restore",
    runtime: "rust",
    label: "Restore module snapshot",
    description:
      "Administrators open Restore from module details, including after removal or deletion. A selector shows snapshot date, reason and version. The dialog shows expiry, the module restored for every account, and replacement of current data. Expired snapshots are unavailable and disable Restore snapshot. The saved host result survives reload; failed reads and changes offer Retry.",
    path: "/settings/modules?module={module}&source={source}&screen=restore",
    scope: "admin"
  },
  {
    id: "rust-module-install-review",
    runtime: "rust",
    label: "Install review",
    description:
      "An administrator opens Install from module details. A shared modal shows the saved package’s publisher, source, version and exact permission headlines and details before explicit approval. Cancel or Escape returns to details. Package changes require a fresh review and approval.",
    path: "/settings/modules?module={module}&source={source}&screen=install",
    scope: "admin"
  },
  {
    id: "rust-module-install-progress",
    runtime: "rust",
    label: "Install progress and result",
    description:
      "The operation URL reads the administrator’s persisted journal, including after reload. Progress advances only when the host reaches real installer boundaries. The result offers Open for modules declaring navigation, otherwise Modules. Download, verification and data setup failures show fixed safe reasons and Retry obtains a fresh review. Status failures offer Retry without starting another install.",
    path: "/settings/modules?module={module}&source={source}&screen=install&operation={operation}",
    scope: "admin"
  },
  {
    id: "rust-module-request-route",
    runtime: "rust",
    label: "Request to install",
    description:
      "The member’s detail action and direct install URL open Ask an admin. Saved requests show Waiting for an admin, Declined, Installing, Install failed or Approved and installed. Check status reads the host. The Installed screen shows the administrator pending count, Review and Decline actions; review uses the existing digest-bound install dialog.",
    path: "/settings/modules?module={module}&source={source}&screen=request",
    scope: "user"
  },
  {
    id: "rust-modules-installed",
    runtime: "rust",
    label: "Modules",
    description:
      "Settings navigation opens installed modules with signed source, version, status, update and pin badges and the signed-in account’s saved switch. Administrators have a separate Server controls disclosure with On for everyone, Export and Import, and a header cog for automatic updates and quiet time.",
    path: "/settings/modules",
    scope: "user"
  },
  {
    id: "rust-modules-browse",
    runtime: "rust",
    label: "Browse modules",
    description:
      "Browse searches verified catalog records and filters by source, category and first-party publisher. Empty results offer Clear filters. Loading and failed catalog reads have visible states and Retry.",
    path: "/settings/modules?view=browse",
    scope: "user"
  },
  {
    id: "rust-module-detail",
    runtime: "rust",
    label: "Module details",
    description:
      "A named module opens source, version, capabilities, changelog, up to four signed digest-checked screenshots with paging and recent configuration activity. The header cog is the only module settings entry and opens the installed module’s declared settings screen. Administrators can review updates, remove, delete or restore data, and pin or unpin the installed version. For a module that is not installed, administrators open install review and members open Request to install.",
    path: "/settings/modules?module={module}&source={source}",
    scope: "user"
  }
];

export const RUST_MODULE_SETTINGS: readonly CoreAppSurfaceDeclaration[] = [
  {
    id: "rust-module-account-switch",
    runtime: "rust",
    label: "On for you",
    description:
      "The installed row changes only the signed-in account’s own saved module choice. Failed saves leave the previous value with an error.",
    path: "/settings/modules",
    scope: "user"
  },
  {
    id: "rust-module-server-controls",
    runtime: "rust",
    label: "Server controls",
    description:
      "Administrators separately change On for everyone. The module-management header cog opens Automatic updates and Quiet time. The detail page offers Pin or Unpin. These controls change configuration only.",
    path: "/settings/modules",
    scope: "admin"
  },
  {
    id: "rust-module-settings-cog",
    runtime: "rust",
    label: "Module settings",
    description:
      "The detail header cog opens the installed module’s declared settings path in its real module frame. Members see only user-scoped settings. Unavailable settings report an error.",
    path: "/settings/modules?module={module}&source={source}",
    scope: "user"
  }
];

export const RUST_MODULE_ERRORS: readonly CoreAppErrorDeclaration[] = [
  {
    code: "core.modules.registry_unavailable",
    runtime: "rust",
    class: "transient",
    remediationRef: "core.modules.registry_retry",
    description:
      "The registry read, signature validation, fingerprint confirmation or import was refused. The screen reports the error and keeps trust pending until confirmed."
  },
  {
    code: "core.modules.local_refused",
    runtime: "rust",
    class: "permission",
    remediationRef: "core.modules.local_retry",
    description:
      "The local package review or install was refused for this session, package or host key storage. A new review is required; admin status never bypasses ownership."
  },
  {
    code: "core.modules.trust_unavailable",
    runtime: "rust",
    class: "transient",
    remediationRef: "core.modules.trust_retry",
    description:
      "Saved package details are unavailable or belong to another account. No private provenance is returned."
  },
  {
    code: "core.modules.request_unavailable",
    runtime: "rust",
    class: "transient",
    remediationRef: "core.modules.request_retry",
    description:
      "Request status, submission or decline could not be saved. Check the persisted status before retrying."
  },
  {
    code: "core.modules.lifecycle_unavailable",
    runtime: "rust",
    class: "transient",
    remediationRef: "core.modules.lifecycle_result",
    description:
      "Module or snapshot reads failed, deletion confirmation mismatched, a snapshot expired, or a saved lifecycle change was refused. Retry reads saved status before offering a fresh change; expired snapshots stay unavailable."
  },
  {
    code: "core.modules.update_failed",
    runtime: "rust",
    class: "transient",
    remediationRef: "core.modules.update_choice_refused",
    description:
      "An update is unavailable, its review changed, or execution failed. The saved result distinguishes confirmed snapshot recovery from other failures; Retry requests a fresh review before another approval."
  },
  {
    code: "core.modules.install_failed",
    runtime: "rust",
    class: "transient",
    remediationRef: "core.modules.install_retry",
    description:
      "The package could not be downloaded, verified or its data set up. The saved operation returns fixed safe messages; private error causes are not rendered."
  },
  {
    code: "core.modules.install_review_changed",
    runtime: "rust",
    class: "validation",
    remediationRef: "core.modules.install_retry",
    description:
      "This package changed. Review it again. Retry creates a new digest-bound review and does not reuse the previous approval."
  },
  {
    code: "core.modules.install_status_unavailable",
    runtime: "rust",
    class: "transient",
    remediationRef: "core.modules.install_retry",
    description:
      "Status unavailable. Check again. Retry reads the saved operation, and cannot create a duplicate installation."
  },
  {
    code: "core.modules.catalog_unavailable",
    runtime: "rust",
    class: "transient",
    remediationRef: "core.modules.catalog_retry",
    description:
      "Catalog, source, screenshot or declared module settings are unavailable; the screen reports the failure rather than inventing records."
  }
];
