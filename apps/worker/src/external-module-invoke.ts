// apps/worker/src/external-module-invoke.ts
//
// #1282 Task 2: the shared trust gate for calling into an external (JSON-manifest) module's
// worker process. ExternalModuleWorkerRuntime.invoke() verifies NOTHING by itself — it just
// takes a discovery and starts it (worker-runtime.ts:55). Every check (active-user
// membership, status, and both manifest_hash and package_hash against the on-disk
// discovery) used to live inline in createExternalModuleJobHandler, the only caller. Now
// there are two callers (the job queue path, and the briefing composer's worker invoker), so
// the gate is extracted into this one helper and the job handler is rewritten to call it — a
// refactor of the job path, not an addition beside it. Two copies of a trust gate is one
// copy that rots.
import type { Kysely } from "kysely";

import type { ExternalBriefingInvoker } from "@moss/briefings";
import type { AccessContext, DataContextDb, DataContextRunner, MossDatabase } from "@moss/db";
import {
  createRuntimeEmbeddingProvider,
  resolveModulePreferences,
  type ExternalModuleDiscovery
} from "@moss/module-registry";
import type { CreateNotificationInput } from "@moss/notifications";
import { createExternalModuleRpcHandler } from "@moss/module-registry/node";
import type {
  ExternalModuleAiRequest,
  ExternalModuleAiResult,
  ExternalModuleAttachmentText,
  ExternalModuleWorkerRuntime
} from "@moss/module-registry/node";
import type { ModuleCredentialCipher } from "@moss/settings";
import type { WorkerLane } from "@moss/module-registry/node";

export interface VerifiedExternalModuleInvokeArgs {
  readonly moduleId: string;
  readonly handler: string;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly jobKind: string;
  readonly idempotencyKey: string;
  readonly params: Record<string, unknown>;
  // #1286 Task 2e: which of the module's three separate child processes this call
  // runs on. Required, not defaulted — every caller (job handler, briefing invoker)
  // must say explicitly which actor/lane isolation boundary it wants; a silent
  // default here is exactly the kind of ambiguity that let two lanes share one
  // process before this task.
  readonly lane: WorkerLane;
  readonly toolRisk: "read" | "write";
  // Per-call override of the runtime's hard invocation ceiling (#1286 Task 2e); a
  // queue's manifest-declared, already-clamped timeoutMs flows through here.
  readonly timeoutMs?: number;
}

export type VerifiedExternalModuleInvokeResult =
  | { readonly ok: true; readonly result: unknown }
  | {
      readonly ok: false;
      readonly reason: "not-active" | "not-discovered" | "not-enabled" | "hash-mismatch";
    };

export type VerifiedInvoke = (
  args: VerifiedExternalModuleInvokeArgs
) => Promise<VerifiedExternalModuleInvokeResult>;

export interface VerifiedExternalModuleInvokerDeps {
  readonly workerDb: Kysely<MossDatabase>;
  // Recomputed from the live discovery holder on every call (#1752) rather than a `Map`
  // captured once at boot — the whole point of the holder is that a module dropped in after
  // boot becomes visible without a restart.
  readonly getDiscoveryById: (moduleId: string) => ExternalModuleDiscovery | undefined;
  // Diagnostic-only: which module ids the trust gate CAN currently see, for the
  // "not-discovered" rejection log below. Empty means the staged package dir itself is
  // missing or unreadable; populated-without-this-id means the module alone failed to stage.
  readonly listDiscoveredModuleIds: () => readonly string[];
  readonly dataContext: DataContextRunner;
  readonly cipher: ModuleCredentialCipher;
  // Structural pick so tests can stub invoke while worker.ts passes the real runtime.
  readonly runtime: Pick<ExternalModuleWorkerRuntime, "invoke">;
  readonly listActiveUserIds: (moduleId: string) => Promise<readonly string[]>;
  // 3-arg app-level bridge (see external-module-ai-bridge.ts); bound to the module id inside
  // the constructed rpc handler below. Optional: not every caller wires AI.
  readonly ai?: (
    scopedDb: DataContextDb,
    moduleId: string,
    request: ExternalModuleAiRequest
  ) => Promise<ExternalModuleAiResult>;
  // ctx.notify (Task 2b, #1283): optional, mirroring `ai` above — a briefing
  // invocation always runs at toolRisk "read" (see createExternalBriefingInvoker
  // below), so notify.post fails closed there via worker-rpc-host.ts's own risk
  // gate regardless of whether this is wired; threading it through anyway keeps
  // one rpc-handler construction site for both callers, exactly like `ai`.
  readonly postNotification?: (
    access: AccessContext,
    input: CreateNotificationInput
  ) => Promise<void>;
  // ctx.attachments.readText (#109 parity fix): mirrors apps/api/src/external-module-tools.ts's
  // ChatAttachmentsService wiring — worker.ts builds the same service against the same vault
  // root and passes a closure of this exact shape. The two composition roots drifted because
  // this dependency was added to the API tool-dispatch path (#932-era) without a matching pass
  // through the worker's queue/briefing path; worker-rpc-host.ts's own `attachments.readText`
  // handler treats an absent readAttachmentText as "no attachment", identical to a genuinely
  // missing one, so the gap was silent rather than a build or runtime failure. Optional here for
  // the same reason `ai`/`postNotification` are: some future caller may still have no attachments
  // service to wire.
  readonly readAttachmentText?: (
    access: AccessContext,
    attachmentId: string
  ) => Promise<ExternalModuleAttachmentText | null>;
  // #1306 Task 22: host-only, opt-in fetch override for UAT/e2e runs (see
  // external-module-job-handler.ts's resolveE2eFetchOverride/createE2eFixtureFetch,
  // the only caller that ever populates this today). Passed straight through to
  // createExternalModuleRpcHandler's own `createFetch` seam below — this type has
  // no opinion about what it does, only that it is optional and module-agnostic.
  readonly createFetch?: (allowedHosts: readonly string[]) => typeof fetch;
  // #1789: the actor's IANA zone, surfaced to the module as ctx.localTimezone.
  //
  // Injected rather than read here, exactly as the AI gateway takes it
  // (packages/ai/src/gateway/gateway.ts:75). This helper has no business knowing that a
  // timezone is stored inside a "locale" preference blob; the composition root already
  // holds the preferences repository and can say so in one place.
  //
  // A queued job has no ToolContext, which is why the synchronous tool path can read the
  // zone straight off ctx while this path needs its own resolver. Both must agree: a meal
  // logged through chat and one logged by a job have to land on the same calendar day.
  readonly resolveLocalTimezone?: (actorUserId: string) => Promise<string | null>;
  // Optional structured logger for trust-gate REJECTIONS only (never the happy path).
  //
  // Why this exists: every gate below resolves the caller to `undefined`, and a pg-boss
  // queue job that resolves to `undefined` is recorded `completed` with NULL output in
  // milliseconds. From outside the process that is indistinguishable from "the handler ran
  // and had nothing to do" — and it emitted no log line at all, so there was nothing to
  // grep. Diagnosing one of these cost multiple redeploy cycles: see the same class of
  // problem in packages/module-registry (#413, module failures the module never sees).
  // A rejection is rare and always actionable, so logging one per rejection is cheap.
  readonly logger?: {
    readonly warn: (obj: Record<string, unknown>, msg?: string) => void;
  };
}

export function createVerifiedExternalModuleInvoker(
  deps: VerifiedExternalModuleInvokerDeps
): VerifiedInvoke {
  /** Logs why the gate refused, then hands the reason back unchanged. */
  const reject = (
    reason: "not-active" | "not-discovered" | "not-enabled" | "hash-mismatch",
    args: VerifiedExternalModuleInvokeArgs,
    detail?: Record<string, unknown>
  ): VerifiedExternalModuleInvokeResult => {
    deps.logger?.warn(
      {
        event: "external_module.trust_gate_rejected",
        reason,
        moduleId: args.moduleId,
        jobKind: args.jobKind,
        requestId: args.requestId,
        ...detail
      },
      "external module invocation rejected by trust gate"
    );
    return { ok: false, reason };
  };
  return async (args) => {
    if (!(await deps.listActiveUserIds(args.moduleId)).includes(args.actorUserId)) {
      return reject("not-active", args);
    }
    const current = deps.getDiscoveryById(args.moduleId);
    if (!current) {
      return reject("not-discovered", args, {
        discovered: deps.listDiscoveredModuleIds()
      });
    }
    const state = await deps.workerDb
      .selectFrom("app.external_modules")
      .select(["status", "manifest_hash", "package_hash", "owner_user_id"])
      .where("id", "=", args.moduleId)
      .executeTakeFirst();
    const canInvokeDraft = state?.status === "draft" && state.owner_user_id === args.actorUserId;
    if (state?.status !== "enabled" && !canInvokeDraft) {
      return reject("not-enabled", args, { status: state?.status ?? null });
    }
    // Compare package_hash, not manifest_hash alone (F10): manifest_hash goes stale on a
    // core change alone, so package_hash is the only real content anchor. Both are still
    // checked (parity with the pre-extraction job handler) — this is "not manifest_hash
    // alone", not "drop manifest_hash".
    if (
      state.manifest_hash !== current.manifestHash ||
      state.package_hash !== current.packageHash
    ) {
      // Both hashes are logged because "which one drifted" is the whole diagnosis: a
      // manifest_hash-only mismatch means a core/manifest change without a re-enable,
      // while a package_hash mismatch means the staged bytes moved under a running worker.
      return reject("hash-mismatch", args, {
        dbManifestHash: state.manifest_hash,
        discoveredManifestHash: current.manifestHash,
        dbPackageHash: state.package_hash,
        discoveredPackageHash: current.packageHash
      });
    }
    const rpc = createExternalModuleRpcHandler({
      module: current,
      toolRisk: args.toolRisk,
      actorUserId: args.actorUserId,
      requestId: args.requestId,
      workerDataContext: deps.dataContext,
      cipher: deps.cipher,
      // ctx.embed (#1281): threaded here too, same as the job path, so a briefing
      // invocation can embed exactly like a scheduled job can.
      embeddingProvider: () =>
        deps.dataContext.withDataContext(
          { actorUserId: args.actorUserId, requestId: args.requestId },
          (scopedDb) => createRuntimeEmbeddingProvider(scopedDb)
        ),
      isActorAdmin: () =>
        deps.dataContext.withDataContext(
          { actorUserId: args.actorUserId, requestId: args.requestId },
          async (scopedDb) =>
            (
              await scopedDb.db
                .selectFrom("app.users")
                .select("is_instance_admin")
                .where("id", "=", args.actorUserId)
                .executeTakeFirst()
            )?.is_instance_admin === true
        ),
      // ctx.notify (Task 2b, #1283): passed through as-is — unlike `ai` below, the
      // signature already matches what createExternalModuleRpcHandler expects, so
      // no per-call moduleId-binding wrapper is needed.
      postNotification: deps.postNotification,
      // ctx.attachments.readText (#109 parity fix): same as postNotification above — the
      // signature already matches, no per-call moduleId binding needed.
      readAttachmentText: deps.readAttachmentText,
      ...(deps.ai ? { ai: (scopedDb, request) => deps.ai!(scopedDb, args.moduleId, request) } : {}),
      // #1306 Task 22: spread only when present — a bare `createFetch: undefined`
      // key would still be "own key `in` the object" and defeat the seam's own
      // "constructed with no createFetch key at all" test when this is unset.
      ...(deps.createFetch ? { createFetch: deps.createFetch } : {})
    });
    // #1725: resolved here, per invocation, inside the ACTOR's data context — never cached
    // across users and never read by the runtime itself. A module reads these off
    // ctx.preferences and can only read them.
    const preferences = await resolveModulePreferences(
      deps.dataContext,
      { actorUserId: args.actorUserId, requestId: args.requestId },
      { id: current.id, preferences: current.manifest.preferences ?? [] }
    );
    // #1789: resolved per invocation for the same reason preferences are — it belongs to the
    // actor, so it can never be cached across users.
    const localTimezone = (await deps.resolveLocalTimezone?.(args.actorUserId)) ?? undefined;
    const result = await deps.runtime.invoke(
      current,
      args.handler,
      {
        actorUserId: args.actorUserId,
        jobKind: args.jobKind,
        idempotencyKey: args.idempotencyKey,
        params: args.params
      },
      rpc,
      {
        lane: args.lane,
        timeoutMs: args.timeoutMs,
        preferences,
        ...(localTimezone ? { localTimezone } : {})
      }
    );
    return { ok: true, result };
  };
}

// #1282 Task 2: adapts the shared trust gate above to the narrower ExternalBriefingInvoker
// shape collectExternalBriefingContributions calls (packages/briefings/src/external-contributions.ts).
// A briefing invocation is read-risk (it fetches a summary, it never writes), so toolRisk is
// fixed here rather than threaded through from the composer, which has no concept of it.
// A non-ok gate outcome is thrown, not returned — collectExternalBriefingContributions already
// swallows a rejection into "no contribution from this module" (J3), so the failure reason only
// ever reaches worker logs, never the composed briefing.
export function createExternalBriefingInvoker(
  deps: VerifiedExternalModuleInvokerDeps
): ExternalBriefingInvoker {
  const invoke = createVerifiedExternalModuleInvoker(deps);
  return async (args) => {
    const outcome = await invoke({
      moduleId: args.moduleId,
      handler: args.handler,
      actorUserId: args.actorUserId,
      requestId: args.requestId,
      jobKind: "briefing",
      idempotencyKey: `briefing:${args.section}:${args.moduleId}:${args.actorUserId}:${args.requestId}`,
      params: { section: args.section },
      toolRisk: "read",
      // #1286 Task 2e: briefings get their own lane/child process, separate from a
      // scheduled job or a same-tick tool call for the same module.
      lane: "briefing"
    });
    if (!outcome.ok) {
      throw new Error(`external module briefing invoke declined: ${outcome.reason}`);
    }
    return outcome.result;
  };
}
