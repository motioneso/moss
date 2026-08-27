// packages/module-sdk/src/external-module.ts
//
// The external (downloadable) module ABI — auth/storage/web/worker declarations, the queue/
// schedule/reconcile-job shapes, JsonMossModuleManifest, and the dataset-connector adapter
// surface (#917/#918/#964/#1019). Lifted verbatim out of index.ts to bring that barrel back
// under the file-size cap — same extraction pattern as
// apps/worker/src/external-module-job-handler.ts. Pure type/const surface, no logic or
// signature changes.
//
// index.ts re-exports everything below, so no import site anywhere in the repo changes: every
// existing `import { X } from "@moss/module-sdk"` still resolves, because @moss/module-sdk
// IS index.ts (package root / tsconfig path / vitest alias all point at it).
//
// Merge note (epic #1280 → main): main and the job-search branch performed this same split
// independently and picked different filenames (`external-module.ts` vs `external-manifest.ts`).
// This file is the union — main's name, with the job-search additions folded in. There is no
// `external-manifest.ts`; do not reintroduce one.
import type {
  ModuleAssistantActionFamilyManifest,
  ModuleAssistantOnboardingManifest,
  ModuleAssistantToolExecutionPolicy,
  ModuleAssistantToolRisk,
  ModuleAssistantToolSelfOperationGrant,
  ModuleCompatibility,
  ModuleLifecycle,
  JsonSchema
} from "./index.js";

/**
 * Credential slot a module declares (#918 Slice 2). Values are stored
 * platform-side in app.module_credentials (AES-256-GCM at rest) and are
 * NOT readable by module code until Slice 3's ctx.auth.getCredential RPC.
 * `id` must be prefixed with the module id ("<moduleId>." + slug).
 */
export interface ModuleAuthDeclaration {
  readonly id: string;
  readonly displayName: string;
  readonly kind: "api-key";
  readonly scope: "instance" | "user";
}

/**
 * KV namespace a module declares (#918 Slice 2). Rows live platform-side in
 * app.module_kv; module code cannot read/write them until Slice 3's ctx.kv RPC.
 * `namespace` must be the module id or "<moduleId>.<slug>".
 */
export interface ModuleStorageDeclaration {
  readonly namespace: string;
  readonly scopes: readonly ("instance" | "user")[];
  /**
   * FIN-00 #1145: who may write instance-scoped rows from module handlers.
   * Default "admin" (today's behavior). "module" opts declared namespaces into
   * handler writes regardless of the acting user's admin status — part of what
   * the admin approves at enable time (manifest hash pins it).
   */
  readonly instanceWritePolicy?: "admin" | "module";
}

/**
 * Web contribution entry (#918 Slice 2). `entrypoint` is a package-relative
 * ESM file served via GET /api/modules/:moduleId/web/*; `contractVersion`
 * must equal the host's JARVIS_WEB_CONTRACT_VERSION or nothing mounts.
 */
export interface ModuleWebDeclaration {
  readonly entrypoint: string;
  readonly contractVersion: number;
}

export interface ModuleWorkerDeclaration {
  readonly workerEntrypoint: string;
  readonly workerContractVersion: 1;
}

export const MODULE_WORKER_CONTRACT_VERSION = 1 as const;

/**
 * Max texts a module may hand `ctx.embed.embedDocuments` in one call (#1281).
 * Declared here, not in the host, so the SDK and the host validation share one
 * number: the in-process embedder is CPU-bound and instance-wide, so an
 * unbounded batch from one module would pin it for every other module.
 */
export const EMBED_BATCH_MAX = 128;

/**
 * Ceiling on any worker queue's declared `timeoutMs` (#1286 Task 2e). Declared here
 * rather than in worker-runtime.ts (which needs `node:child_process`) so that
 * validate.ts — the browser-safe manifest validator re-exported from
 * @moss/module-registry's browser entry — can import and enforce it without
 * pulling a node:* dependency into a bundle apps/web also consumes. worker-runtime.ts
 * imports and re-exports this same constant so the runtime and the validator can
 * never drift.
 */
export const MAX_INVOCATION_MS = 600_000;

export type ModuleParamScalarSchema =
  | { readonly type: "uuid" | "identifier" | "timestamp" | "boolean" | "null" }
  | { readonly type: "string"; readonly maxLength: number }
  | { readonly type: "integer" | "number"; readonly min: number; readonly max: number }
  | { readonly type: "enum"; readonly values: readonly string[] };

export type ModuleParamsSchema =
  | ModuleParamScalarSchema
  | { readonly type: "array"; readonly items: ModuleParamScalarSchema; readonly maxItems: number }
  | {
      readonly type: "object";
      readonly fields: Readonly<
        Record<
          string,
          | ModuleParamScalarSchema
          | {
              readonly type: "array";
              readonly items: ModuleParamScalarSchema;
              readonly maxItems: number;
            }
        >
      >;
    };

export interface ExternalModuleQueueDeclaration {
  readonly name: string;
  readonly handler: string;
  readonly paramsSchema?: ModuleParamsSchema;
  readonly retryLimit?: number;
  readonly deadLetterQueue?: string;
  readonly allowManualRun?: boolean;
  // #1286 Task 2e: per-queue override of the worker's hard invocation ceiling
  // (WorkerLane's invocationHardTimeoutMs default), clamped to MAX_INVOCATION_MS by
  // validateWorker below. Absent means the runtime's own default applies.
  readonly timeoutMs?: number;
}

export interface ExternalModuleScheduleDeclaration {
  readonly id: string;
  readonly cron: string;
  readonly tz?: string;
  readonly queue: string;
  readonly jobKind: string;
  readonly scope: "user";
  readonly params?: Readonly<Record<string, unknown>>;
}

/**
 * #1166 (F6-D4): a job the platform enqueues ONCE PER ACTIVE USER every time
 * the module is reconciled (boot, enable, manifest change). For backfill /
 * repair work. Deliveries repeat across reconciles — handlers MUST be
 * idempotent (marker check); the singletonKey only dedups concurrent sends.
 */
export interface ExternalModuleReconcileJobDeclaration {
  readonly id: string;
  /** Must name one of this module's declared worker queues. */
  readonly queue: string;
  readonly jobKind: string;
}

export interface ExternalModuleWorkerDeclaration {
  readonly queues?: readonly ExternalModuleQueueDeclaration[];
  readonly schedules?: readonly ExternalModuleScheduleDeclaration[];
  readonly reconcileJobs?: readonly ExternalModuleReconcileJobDeclaration[];
}

export interface ModuleFetchRequest {
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly bodyBase64?: string;
}

export interface ModuleFetchResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly bodyBase64: string;
}

export interface ExternalModuleConfirmWhenClause {
  readonly key: string;
  readonly equals: string | number | boolean;
}

export interface ExternalModuleAssistantToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly actionLabel?: string;
  readonly permissionId: string;
  readonly risk: ModuleAssistantToolRisk;
  readonly actionFamilyId?: string;
  readonly executionPolicy?: ModuleAssistantToolExecutionPolicy;
  readonly selfOperationGrant?: ModuleAssistantToolSelfOperationGrant;
  readonly confirmWhen?: readonly ExternalModuleConfirmWhenClause[];
  readonly confirmWhenKeys?: readonly string[];
  readonly inputSchema?: JsonSchema;
  readonly outputSchema?: JsonSchema;
  readonly handler: string;
}

/**
 * Database surface of a downloadable module (#964). Declaration only — the privileged
 * installer (scripts/module-install.ts) creates tables from the module's sql/ directory;
 * the manifest declares which app-schema table names the module owns so install, purge,
 * and registry capability display all key off one list. Validation (module-registry)
 * enforces the `app.<module_slug>_` prefix so no module can claim another's tables.
 */
export interface ExternalModuleDatabaseDeclaration {
  readonly ownedTables: readonly string[];
}

/**
 * A single nav-menu entry a downloadable module contributes (#1019). Narrower than the
 * built-in `ModuleNavigationEntryManifest` — deliberately omits `permissionId` /
 * `featureFlagId` (those gate built-in-only surfaces); an external module cannot declare
 * either through this ABI. `path` is module-relative; `serializeExternalModule`
 * (apps/api/src/server.ts) is the ONLY place that turns it into a real route by prefixing
 * it with `/m/<moduleId>`.
 */
export interface ExternalModuleNavigationEntry {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly icon?: string;
  readonly order?: number;
  /**
   * A count badge on this nav entry (#1285). Closed enum with one member today. A badge
   * is always derived from a core-owned count — never from module-supplied text or a
   * module tool result (the `action_result.result` channel doesn't exist yet at HEAD) —
   * so the module can only choose *which* core count to display, never the number
   * itself. `"notifications"` means this module's unread notification count
   * (`NotificationDto.moduleId`, rulings-ledger G6).
   */
  readonly badge?: {
    readonly source: "notifications";
  };
}

/**
 * A resolved preference value as the host hands it to a module (#1757).
 *
 * `null` belongs to integer preferences alone and means the user has deliberately left the
 * number unset. It is not zero, and a module must treat it as "no answer" rather than
 * substituting one — Food's daily calorie target is the case that forced the distinction.
 */
export type ExternalModulePreferenceValue = boolean | number | null;

/** Fields every declared preference carries, whatever its type. */
interface ExternalModulePreferenceBase {
  /** Lower camel-case identifier, unique within the module. Namespaced by moduleId in storage. */
  readonly key: string;
  /** The control's label on the settings page. */
  readonly label: string;
  /** Optional one-line explanation shown under the label. */
  readonly description?: string;
}

/** An on/off switch. */
export interface ExternalModuleBooleanPreference extends ExternalModulePreferenceBase {
  readonly type: "boolean";
  /** Applied whenever the user has never touched the switch — nothing is written at install. */
  readonly default: boolean;
}

/**
 * A whole number the user types (#1757).
 *
 * Integer only, and no enum or free text: those would put module-authored strings on a
 * settings page and into stored user data, which needs the four guards from the determinism
 * boundary. A number has no such problem — the host renders it, bounds it, and the module
 * never sees a string it did not itself declare.
 */
export interface ExternalModuleIntegerPreference extends ExternalModulePreferenceBase {
  readonly type: "integer";
  /** Inclusive lower bound. Optional; the host still rejects anything non-integer. */
  readonly min?: number;
  /** Inclusive upper bound. */
  readonly max?: number;
  /**
   * The value a user who has never touched the field gets. `null` declares that "unset" is
   * a supported end state for this preference — the user can also clear the field back to it.
   * A numeric default means the field always has a number in it.
   */
  readonly default: number | null;
}

/**
 * One user-facing setting an installed module declares (#1725, widened to numbers in #1757).
 *
 * The compiled-in `settings` field stays forbidden (FORBIDDEN_FIELDS) because it carries
 * a React component the host would have to execute. This is data only: the host renders
 * the control, owns the storage (`app.preferences`, key `module:<moduleId>:<key>`, RLS
 * owner-only) and hands the resolved values to the module read-only at invocation. A
 * module can never write its own preference, and never sees another user's.
 */
export type ExternalModulePreferenceDeclaration =
  | ExternalModuleBooleanPreference
  | ExternalModuleIntegerPreference;

/**
 * How an external module contributes to a daily briefing (#1282).
 *
 * Core modules reach a briefing by registering an in-process assistant tool the
 * composer resolves and calls. An external module ships JSON and has no `execute`
 * function it could ever register, so it declares a WORKER HANDLER here instead and
 * the composer reaches it through an injected invoker. This is a worker handler, not
 * an `assistantTools` entry, so it is already invisible to the chat tool registry —
 * that is why there is no `briefingOnly` flag to set.
 */
export interface ExternalModuleBriefingDeclaration {
  /** Worker handler name. Requires `runtime.workerEntrypoint` — a briefing handler with no worker to run it is an error, not a no-op. */
  readonly handler: string;
  /** Which briefings this module may appear in. Non-empty. */
  readonly sections: readonly ("morning" | "evening")[];
  /** The name the user selects in briefing settings; conventionally `<moduleId>.briefing`. */
  readonly toolName: string;
}

/**
 * The JSON-serializable subset of {@link MossModuleManifest} that an EXTERNAL
 * (non-compiled) module ships as `jarvis.module.json` (#917). It deliberately omits
 * every function-valued or executable-surface field of the compiled manifest —
 * external modules contribute identity/compat metadata only in Slice 1. `auth` and
 * `storage` are declaration-only and REJECTED at load in this slice (see the
 * metadata-only invariant); they are typed here for forward compatibility.
 */
export interface JsonMossModuleManifest {
  /**
   * On-disk envelope contract version (#917, spec revision 2026-07-10 for PR #924). Slice 1
   * ships a FLAT metadata-only manifest with a single top-level `schemaVersion: 1`, validated
   * at load. The spec's nested `runtime.workerContractVersion` / optional `web.contractVersion`
   * are DEFERRED to Slices 2-3, where the worker and web-asset loaders that consume them first
   * exist — Slice 1 executes no worker and serves no web assets, so those fields would guard
   * nothing this slice. Bumping this integer is how a future incompatible on-disk shape is gated.
   */
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly publisher: string;
  readonly description?: string;
  readonly lifecycle: ModuleLifecycle;
  readonly compatibility: ModuleCompatibility;
  readonly auth?: readonly ModuleAuthDeclaration[];
  readonly storage?: readonly ModuleStorageDeclaration[];
  readonly web?: ModuleWebDeclaration;
  readonly runtime?: ModuleWorkerDeclaration;
  readonly assistantTools?: readonly ExternalModuleAssistantToolDeclaration[];
  readonly assistantActionFamilies?: readonly ModuleAssistantActionFamilyManifest[];
  readonly worker?: ExternalModuleWorkerDeclaration;
  readonly fetchHosts?: readonly string[];
  /**
   * Names a declared `storage` namespace (must have `scopes` including "user") whose keys are
   * runtime-granted fetch hosts for the invoking actor, merged with `fetchHosts` by
   * worker-rpc-host.ts's `fetch.request` branch (#1309, Task 24). Absent means the module has no
   * runtime grants — its fetch surface is exactly `fetchHosts`, as before this field existed.
   */
  readonly fetchHostGrantsNamespace?: string;
  readonly database?: ExternalModuleDatabaseDeclaration;
  /**
   * Nav-menu entries this module contributes (#1019). Optional — a metadata-only module
   * declares none and gets no nav entry, same as before this field existed. 1-4 entries,
   * validated positively in packages/module-registry/src/external/validate.ts.
   */
  readonly navigation?: readonly ExternalModuleNavigationEntry[];
  /**
   * On/off switches this module offers on its host-rendered settings page (#1725).
   * Optional — a module that declares none gets no settings page. 1-8 entries, validated
   * positively in packages/module-registry/src/external/validate.ts.
   */
  readonly preferences?: readonly ExternalModulePreferenceDeclaration[];
  /**
   * Briefing contribution (#1282). External modules cannot register an in-process
   * assistant tool, so the composer reaches them through an injected worker invoker
   * instead. Optional: a module that declares none contributes no briefing section.
   */
  readonly briefing?: ExternalModuleBriefingDeclaration;
  readonly assistantOnboarding?: ModuleAssistantOnboardingManifest;
}

/**
 * A validated external module package: its parsed metadata-only manifest plus the
 * two content hashes the platform trusts it by (#917). `manifestHash` is over the
 * canonical (sorted-key) manifest JSON; `packageHash` is over the whole package
 * (manifest + dist/worker.js + dist/web/**). Drift in `packageHash` from the value
 * recorded at admin-enable auto-disables the module.
 */
export interface ExternalMossModulePackage {
  readonly manifest: JsonMossModuleManifest;
  readonly manifestHash: string;
  readonly packageHash: string;
}

/**
 * Dataset connector SDK (docs/superpowers/specs/2026-07-04-module-dataset-connector-sdk.md).
 * A module declares external HTTP data sources it needs here; the `@moss/datasets` runtime
 * host executes fetches under the declared constraints (host pinning, TTL caching, staleness
 * policy). Adapters never call global `fetch` directly — they receive a pinned `fetchFn` via
 * {@link ExternalSourceAdapterContext}.
 */
export type ModuleExternalSourceCredential = "none" | "api-key";

/**
 * Context an `ExternalSourceAdapter` receives per call. `fetchFn` is already host-pinned
 * (exact-hostname allowlist, https-only, redirect-hop re-validated) to the declaring source's
 * `fetchHosts` — adapters must use it instead of the global `fetch`. `apiKey` carries the acting
 * person's own credential and is set by exactly one caller: the keyed dataset runtime
 * (`createKeyedDatasetClient` in @moss/datasets), which serves connections written into a
 * reviewed registry in the owning module. The manifest-declared `externalSources` path still
 * rejects `credential: "api-key"` at registration, so `apiKey` is always absent there.
 */
export interface ExternalSourceAdapterContext {
  readonly fetchFn: typeof fetch;
  readonly apiKey?: string;
}

/**
 * The swappable per-source fetch contract. `datasetKey` selects one of the source's declared
 * `datasets`; `params` is the adapter-defined (and adapter-validated) request shape for that
 * dataset. Return value is opaque to the runtime — the module's own service layer owns typing.
 */
export interface ExternalSourceAdapter {
  fetchDataset(
    datasetKey: string,
    params: Record<string, unknown>,
    ctx: ExternalSourceAdapterContext
  ): Promise<unknown>;
}

export interface ModuleDatasetManifest {
  /** Unique within the declaring source, e.g. "scoreboard". */
  readonly key: string;
  readonly ttlMs: number;
  /**
   * "serve-stale-on-error" keeps a stale cache entry available for `staleRetentionMs` after
   * expiry so a fetch failure can still serve it (degraded); "degrade-empty" drops the entry at
   * TTL expiry and falls back to the caller-supplied fallback value on fetch failure.
   */
  readonly staleness: "serve-stale-on-error" | "degrade-empty";
  /** serve-stale-on-error only; defaults to 6 hours. */
  readonly staleRetentionMs?: number;
}

export interface ModuleExternalSourceManifest {
  /** Globally unique across every built-in module; asserted at registration. */
  readonly id: string;
  readonly displayName: string;
  /** OAuth is deliberately excluded (non-goal). "api-key" is reserved; registration rejects it. */
  readonly credential: ModuleExternalSourceCredential;
  /** Exact hostnames the adapter may hit. Lowercase, no port, no IP literal. */
  readonly fetchHosts: readonly string[];
  /** Aggregated into the web CSP img-src allowlist. */
  readonly imageHosts?: readonly string[];
  readonly datasets: readonly ModuleDatasetManifest[];
  /** Rate-courtesy minimum interval between fetches to this source, in ms. Defaults to none. */
  readonly minIntervalMs?: number;
}
