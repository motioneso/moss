import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { ChatAttachmentsService } from "@moss/chat";
import type { MossModuleManifest, ToolResult } from "@moss/module-sdk";
import {
  createNotificationPreferencePort,
  createRuntimeEmbeddingProvider,
  reconcileExternalModules,
  resolveModulePreferences,
  type ExternalModuleDiscovery,
  type ReconciledExternalModule
} from "@moss/module-registry";
import {
  createExternalModuleRpcHandler,
  createExternalToolManifests,
  ExternalModuleWorkerRuntime,
  type ExternalModuleAiRequest,
  type ExternalModuleAiResult,
  type ExternalToolInvoker
} from "@moss/module-registry/node";
import { NotificationsRepository } from "@moss/notifications";
import { createModuleCredentialSecretCipher, type SettingsRepository } from "@moss/settings";
import { getVaultBaseDir, VaultContextRunner } from "@moss/vault";

export function createExternalModuleTools(input: {
  readonly discoveries: () => readonly ExternalModuleDiscovery[];
  readonly workerDataContext?: DataContextRunner;
  readonly appDataContext: DataContextRunner;
  readonly settingsRepository: SettingsRepository;
  readonly logger: { warn(data: Record<string, unknown>, message?: string): void };
  // ctx.ai bridge (#932, spec D6): injected from server.ts so module-registry never
  // imports @moss/ai. The queued-jobs path has its own equivalent bridge — see
  // apps/worker/src/external-module-ai-bridge.ts, wired in apps/worker/src/worker.ts —
  // so a module can reach structured AI from both a synchronous tool and a queue handler.
  readonly ai?: (
    scopedDb: DataContextDb,
    moduleId: string,
    request: ExternalModuleAiRequest
  ) => Promise<ExternalModuleAiResult>;
}): {
  readonly runtime?: ExternalModuleWorkerRuntime;
  readonly getManifests: () => readonly MossModuleManifest[];
} {
  if (!input.workerDataContext) return { getManifests: () => [] };
  const runtime = new ExternalModuleWorkerRuntime({ logger: input.logger });
  const cipher = createModuleCredentialSecretCipher();
  const attachments = new ChatAttachmentsService(new VaultContextRunner(getVaultBaseDir()));
  // ctx.notify (Task 2b, #1283): no quiet-hours port, matching
  // registerUpgradeNotifyWorker's own NotificationsRepository construction
  // (apps/worker/src/worker.ts) — a module-posted notification is not deferred
  // by the recipient's quiet hours any more than the system upgrade notice is.
  const notifications = new NotificationsRepository(undefined, createNotificationPreferencePort());
  const invoke: ExternalToolInvoker = async (module, tool, toolInput, context) => {
      const rpc = createExternalModuleRpcHandler({
        module,
        toolRisk: tool.risk,
        actorUserId: context.actorUserId,
        requestId: context.requestId,
        workerDataContext: input.workerDataContext!,
        cipher,
        isActorAdmin: () =>
          input.appDataContext.withDataContext(
            { actorUserId: context.actorUserId, requestId: context.requestId },
            async (scopedDb) =>
              (await input.settingsRepository.getUserById(scopedDb, context.actorUserId))
                ?.is_instance_admin === true
          ),
        // ctx.embed (#1281): resolved from the same runtime seam memory search
        // uses, so the configured provider/model stays a single decision and is
        // never named here. Lazy — only an invocation that actually embeds pays
        // for the config read.
        embeddingProvider: () =>
          input.appDataContext.withDataContext(
            { actorUserId: context.actorUserId, requestId: context.requestId },
            (scopedDb) => createRuntimeEmbeddingProvider(scopedDb)
          ),
        readAttachmentText: async (access, attachmentId) => {
          const content = await attachments.readContent(access, attachmentId);
          return content.kind === "text"
            ? {
                fileName: content.meta.fileName,
                mimeType: content.meta.mimeType,
                text: content.text
              }
            : null;
        },
        // ctx.notify (Task 2b, #1283): opens its own scoped db via appDataContext,
        // separate from workerDataContext above — notify.post runs outside the
        // db.query/ai.generateStructured withDataContext block in worker-rpc-host.ts,
        // so it needs a context of its own rather than reusing one already closed.
        postNotification: async (access, notifyInput) => {
          await input.appDataContext.withDataContext(access, (scopedDb) =>
            notifications.create(scopedDb, notifyInput)
          );
        },
        // Bind the module id here so the rpc host stays module-agnostic; the host
        // still enforces risk gating, the composition guard, and the call cap.
        ...(input.ai ? { ai: (db, req) => input.ai!(db, module.id, req) } : {})
      });
      // #1768: resolved per invocation inside the ACTOR's data context, exactly as the
      // queued path does in apps/worker/src/external-module-invoke.ts. Without this the
      // synchronous tool path handed the module an empty preference set, so every read
      // fell back to the manifest default and no saved switch or number the user set in
      // Settings ever reached the module.
      const preferences = await resolveModulePreferences(
        input.appDataContext,
        { actorUserId: context.actorUserId, requestId: context.requestId },
        { id: module.id, preferences: module.manifest.preferences ?? [] }
      );
      // FIN-04 (#1149, spec delta "Host change 2"): hand the worker the
      // host-resolved actor identity in tool input, matching the queue job
      // envelope's actorUserId field. The host value MUST stay spread LAST:
      // validateToolInput deliberately does not enforce additionalProperties
      // (#133), so a caller CAN smuggle an `actorUserId` key through schema
      // validation — spread order, not schema rejection, is the spoof defense.
      return externalToolResult(
        await runtime.invoke(
          module,
          tool.handler,
          { ...toolInput, actorUserId: context.actorUserId },
          rpc,
          // #1286 Task 2e: an assistant tool call gets its own child process,
          // separate from this module's queue jobs and briefing invocations.
          // #1789: the actor's zone, already resolved on the ToolContext by the AI gateway
          // for every tool call. Built-in tools have always read it straight off ctx; an
          // external module had no way to see it and had to trust whatever timezone the
          // model put in the tool input.
          {
            lane: "tool",
            preferences,
            ...(context.localTimezone ? { localTimezone: context.localTimezone } : {})
          }
        )
      );
  };
  // #1902: manifests are rebuilt from the live discoveries getter on every call, not once at
  // construction — createExternalToolManifests is a cheap pure filter/map over discoveries, so a
  // module discovered after this function ran (an install, a draft, a rescan) shows up on the
  // next call with no restart. `invoke` itself does not depend on discoveries, so it stays a
  // single closure built once above.
  const getManifests = () => createExternalToolManifests(input.discoveries(), invoke);
  return { runtime, getManifests };
}

/**
 * Per-actor active-module resolver: instance-enabled minus the actor's deny
 * rows. Extracted from server.ts composition (#932) — behavior unchanged.
 * #996/#860: always-defined now — external modules are always-on, so there is
 * no "disabled by config" case to return undefined for.
 */
export function createActiveExternalModulesResolverForApi(input: {
  readonly appDataContext: DataContextRunner;
  readonly settingsRepository: SettingsRepository;
  readonly discoveries: () => readonly ExternalModuleDiscovery[];
}): (accessContext: AccessContext) => Promise<readonly ReconciledExternalModule[]> {
  return async (accessContext) => {
    const { states, denyRows } = await input.appDataContext.withDataContext(
      accessContext,
      async (scopedDb) => ({
        states: await input.settingsRepository.listExternalModuleStates(scopedDb),
        denyRows: await input.settingsRepository.listModuleDenyRowsForActor(scopedDb)
      })
    );
    const { modules } = reconcileExternalModules(input.discoveries(), states);
    const disabled = new Set(denyRows.map((row) => row.module_id));
    // #1753: a draft module is only visible to the actor who built it, until it ships.
    const visibleToActor = (module: ReconciledExternalModule) =>
      module.status !== "draft" || module.ownerUserId === accessContext.actorUserId;
    return modules.filter(
      (module) => module.active && !disabled.has(module.id) && visibleToActor(module)
    );
  };
}

/**
 * #1762: the same reconcile, but WITHOUT subtracting the actor's own deny rows.
 *
 * The settings Modules pane needs the modules a user *could* use, not the ones they have left
 * switched on — a module filtered out by its own off switch disappears from the list, and the
 * switch that turned it off goes with it. Every other caller wants the filtered set, which is why
 * this is a separate resolver rather than a flag on the one above.
 */
export function createInstalledExternalModulesResolverForApi(input: {
  readonly appDataContext: DataContextRunner;
  readonly settingsRepository: SettingsRepository;
  readonly discoveries: () => readonly ExternalModuleDiscovery[];
}): (accessContext: AccessContext) => Promise<readonly ReconciledExternalModule[]> {
  return async (accessContext) => {
    const states = await input.appDataContext.withDataContext(accessContext, async (scopedDb) =>
      input.settingsRepository.listExternalModuleStates(scopedDb)
    );
    const { modules } = reconcileExternalModules(input.discoveries(), states);
    // #1753: a draft module is only visible to the actor who built it, until it ships.
    // Same rule as createActiveExternalModulesResolverForApi above — this resolver skips the
    // deny-row subtraction but must not skip the draft-ownership check.
    const visibleToActor = (module: ReconciledExternalModule) =>
      module.status !== "draft" || module.ownerUserId === accessContext.actorUserId;
    return modules.filter((module) => module.active && visibleToActor(module));
  };
}

export function createExternalActiveModulesResolver(
  resolveEnabledModules: (actorUserId: string) => Promise<readonly MossModuleManifest[]>,
  getExternalModuleIds: () => ReadonlySet<string>,
  getActiveExternalModules: (actorUserId: string) => Promise<readonly { id: string }[]>
): (actorUserId: string) => Promise<readonly MossModuleManifest[]> {
  return async (actorUserId) => {
    const externalModuleIds = getExternalModuleIds();
    if (externalModuleIds.size === 0) return resolveEnabledModules(actorUserId);
    const [enabled, activeExternal] = await Promise.all([
      resolveEnabledModules(actorUserId),
      getActiveExternalModules(actorUserId)
    ]);
    const activeIds = new Set(activeExternal.map((module) => module.id));
    return enabled.filter(
      (manifest) => !externalModuleIds.has(manifest.id) || activeIds.has(manifest.id)
    );
  };
}

/**
 * #1662: a module that handled its own error returns an envelope carrying `status: "error"`
 * (see `external-modules/finance/src/worker/wrap.ts` — the shape every module's wrapper uses).
 * A tool's execute has exactly one way to say "this failed": throw. Returning anything at all
 * means success to the gateway, which then audits the row `success` and tells the user the
 * action executed. So a module that reported a failure honestly was recorded as having worked.
 *
 * Worse when the envelope also carried a `data` field: the branch below returned the whole
 * envelope as the ToolResult, and every consumer reads only `.data`, so the error status was not
 * merely mis-audited but invisible — the model got the partial payload with nothing marking it
 * as partial.
 *
 * Throwing hands the failure to the gateway's own catch (`runHandler`), which is what turns the
 * row into `outcome: "failed"` and the chat event into `outcome: "error"`. The module's `code`
 * rides along on the thrown error; the gateway deliberately does not read it, so nothing new
 * reaches the model, but it is there for a log line or a future error channel.
 *
 * Top-level `status` is an envelope field by convention across every module in the tree, and
 * `"error"` is only ever its failure value (`"ok"`, `"no-op"`, `"recorded"`, `"migrated"` are the
 * successes). A nested `status: "error"` — a bank link in an error state, one failed item in a
 * sync — is data about the world, not a failed call, and is untouched here.
 */
export class ExternalModuleReportedError extends Error {
  constructor(readonly code: string | undefined) {
    super("Module reported an error");
    this.name = "ExternalModuleReportedError";
  }
}

export function externalToolResult(value: unknown): ToolResult {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record.status === "error") {
      throw new ExternalModuleReportedError(
        typeof record.code === "string" ? record.code : undefined
      );
    }
    if (record.data && typeof record.data === "object" && !Array.isArray(record.data)) {
      return value as ToolResult;
    }
    return { data: record };
  }
  return { data: { value } };
}
