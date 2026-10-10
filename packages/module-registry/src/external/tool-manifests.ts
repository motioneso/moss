import type { DataContextDb } from "@moss/db";
import type {
  ClassifierCandidate,
  ClassifierCandidateProvider,
  ExternalModuleAssistantToolDeclaration,
  ModuleAssistantToolClassifier,
  MossModuleManifest,
  ToolContext,
  ToolInput,
  ToolRequiresConfirmation,
  ToolResult
} from "@moss/module-sdk";

import { PreferencesRepository } from "@moss/structured-state";

import { modulePreferenceKey } from "./preferences.js";
import type { ExternalModuleDiscovery, ReconciledExternalModule } from "./types.js";
import { hashCanonicalManifest } from "./hash.js";

// These bindings come only from host synthesis, never from installed JSON. They tie a
// concurrently resolved tool manifest to the accepted package snapshot that produced it.
const synthesizedSnapshots = new WeakMap<
  MossModuleManifest,
  { readonly manifestHash: string; readonly packageHash: string; readonly descriptorHash: string }
>();

/** A per-actor copy: shared registry manifests must never acquire an owner's trust stamp. */
export function withExternalDescriptorApproval(
  manifest: MossModuleManifest,
  active: Pick<
    ReconciledExternalModule,
    "id" | "manifestHash" | "packageHash" | "descriptorApprovedByUserId"
  >,
  actorUserId: string
): MossModuleManifest {
  const snapshot = synthesizedSnapshots.get(manifest);
  const approved =
    active.descriptorApprovedByUserId === actorUserId &&
    snapshot !== undefined &&
    snapshot.manifestHash === active.manifestHash &&
    snapshot.packageHash === active.packageHash &&
    snapshot.descriptorHash === hashCanonicalManifest(manifest);
  return {
    ...manifest,
    ...(manifest.assistantTools
      ? {
          assistantTools: manifest.assistantTools.map((tool) => ({
            ...tool,
            inputSchema: tool.inputSchema ? structuredClone(tool.inputSchema) : undefined,
            outputSchema: tool.outputSchema ? structuredClone(tool.outputSchema) : undefined,
            classifier: tool.classifier
              ? {
                  ...tool.classifier,
                  arguments: tool.classifier.arguments
                    ? structuredClone(tool.classifier.arguments)
                    : undefined
                }
              : undefined,
            descriptorOwnerUserId: approved ? actorUserId : undefined
          }))
        }
      : {})
  };
}

export type ExternalToolInvoker = (
  module: ExternalModuleDiscovery,
  tool: ExternalModuleAssistantToolDeclaration,
  input: ToolInput,
  context: ToolContext,
  // The caller's already-open database handle. Lookups that need the database must use it,
  // because the route holds the request's connection and a second one can deadlock a pool.
  scopedDb?: DataContextDb
) => Promise<ToolResult>;

/**
 * Runs one installable module's candidate hook (plan 2.2, #2882). `handler` names a worker handler
 * exposed through `defineModuleWorker`; the host invokes it through the existing sandbox/RPC
 * runtime, actor-scoped and read-only. The returned list is validated by the caller with
 * `normalizeClassifierCandidates`, so this boundary stays `unknown`.
 */
export type ExternalCandidateInvoker = (
  module: ExternalModuleDiscovery,
  handler: string,
  access: { readonly actorUserId: string; readonly requestId: string },
  signal: AbortSignal
) => Promise<unknown>;

/** Reads the actor's stored preferences (module-namespaced keys) under their data context. */
export type ExternalPreferenceReader = (scopedDb: unknown) => Promise<Record<string, unknown>>;

const readStoredPreferences: ExternalPreferenceReader = (scopedDb) =>
  new PreferencesRepository().list(scopedDb as Parameters<PreferencesRepository["list"]>[0]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * True when the change exceeds the limit, and also when it cannot be judged. Every unreadable
 * piece (input, declared base, preference) asks, so the rule fails closed.
 */
async function exceedsConfirmAbove(
  module: ExternalModuleDiscovery,
  rule: NonNullable<ExternalModuleAssistantToolDeclaration["confirmAbove"]>,
  scopedDb: unknown,
  input: ToolInput,
  readPreferences: ExternalPreferenceReader
): Promise<boolean> {
  try {
    const amount = input[rule.inputKey];
    if (!isFiniteNumber(amount)) return true;
    let base = 0;
    if (rule.baseKey !== undefined) {
      const declaredBase = input[rule.baseKey];
      if (!isFiniteNumber(declaredBase)) return true;
      base = declaredBase;
    }
    if (!isFiniteNumber(rule.scale) || rule.scale <= 0) return true;

    const declaration = module.manifest.preferences?.find((p) => p.key === rule.preferenceKey);
    if (declaration?.type !== "integer") return true;
    const stored = (await readPreferences(scopedDb))[
      modulePreferenceKey(module.id, rule.preferenceKey)
    ];
    // Only a missing value uses the default. A cleared (null) or unreadable stored value
    // leaves no known limit, so the tool asks.
    const limit = stored === undefined ? declaration.default : stored;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit)) return true;

    return Math.abs(amount - base) > limit * rule.scale;
  } catch {
    return true;
  }
}

function synthesizeRequiresConfirmation(
  module: ExternalModuleDiscovery,
  tool: ExternalModuleAssistantToolDeclaration,
  readPreferences: ExternalPreferenceReader
): ToolRequiresConfirmation | undefined {
  const confirmAbove = tool.confirmAbove;
  if (!tool.confirmWhen?.length && !tool.confirmWhenKeys?.length && !confirmAbove) {
    return undefined;
  }
  return async (scopedDb, input) =>
    tool.confirmWhenKeys?.some((key) => Object.hasOwn(input, key)) === true ||
    tool.confirmWhen?.some(
      ({ key, equals }) => Object.hasOwn(input, key) && input[key] === equals
    ) === true ||
    (confirmAbove !== undefined &&
      (await exceedsConfirmAbove(module, confirmAbove, scopedDb, input, readPreferences)));
}

/**
 * Turns the JSON classifier declaration into the SDK's function form. The candidate list is a
 * handler name, so it becomes a provider that delegates to `invokeCandidates`; without an invoker
 * there is no provider and `checkClassifierEligibility` marks any candidates argument ineligible.
 * A field-by-field copy, like the tool remap below: a hostile key must not ride a spread through.
 */
function synthesizeClassifier(
  module: ExternalModuleDiscovery,
  tool: ExternalModuleAssistantToolDeclaration,
  invokeCandidates: ExternalCandidateInvoker | undefined
): ModuleAssistantToolClassifier | undefined {
  const decl = tool.classifier;
  if (!decl) return undefined;
  const handler = decl.candidatesHandler;
  const candidates: ClassifierCandidateProvider | undefined =
    handler !== undefined && invokeCandidates !== undefined
      ? (_scopedDb, ctx, options) =>
          invokeCandidates(
            module,
            handler,
            { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
            options.signal
          ) as Promise<readonly ClassifierCandidate[]>
      : undefined;
  return {
    description: decl.description,
    ...(decl.arguments ? { arguments: decl.arguments } : {}),
    ...(candidates ? { candidates } : {}),
    replyTemplate: decl.replyTemplate
  };
}

export function createExternalToolManifests(
  discoveries: readonly ExternalModuleDiscovery[],
  invoke: ExternalToolInvoker,
  invokeCandidates?: ExternalCandidateInvoker,
  readPreferences: ExternalPreferenceReader = readStoredPreferences
): MossModuleManifest[] {
  return discoveries
    .filter((module) => module.manifest.runtime && module.manifest.assistantTools?.length)
    .map((module) => {
      const manifest: MossModuleManifest = {
        id: module.id,
        name: module.manifest.name,
        version: module.manifest.version,
        publisher: module.manifest.publisher,
        lifecycle: module.manifest.lifecycle,
        compatibility: module.manifest.compatibility,
        assistantOnboarding: module.manifest.assistantOnboarding,
        assistantActionFamilies: module.manifest.assistantActionFamilies,
        // #1725: carried through so the settings list can offer a "Configure" link without
        // asking every installed module for its preferences one at a time.
        preferences: module.manifest.preferences,
        availability: {
          defaultEnabled: false,
          supportsUserDisable: module.manifest.lifecycle === "user-toggleable"
        },
        assistantTools: module.manifest.assistantTools?.map((tool) => {
          const requiresConfirmation = synthesizeRequiresConfirmation(
            module,
            tool,
            readPreferences
          );
          // #2152: `safeErrors` is deliberately NOT copied here. It opts a tool into echoing its
          // own thrown HttpError text to the user and the model (#1679/#2148), and the gateway
          // repeats that text verbatim — a first-party trust decision, not something an installed
          // module's manifest gets to select. The copy is field-by-field, so the key is absent by
          // construction; `external-module-tool-manifest-policy.test.ts` pins that (a hostile
          // declaration carrying `safeErrors: true` still yields a tool without it), so swapping
          // this map for a copy-everything spread cannot start forwarding it by accident.
          return {
            name: tool.name,
            description: tool.description,
            actionLabel: tool.actionLabel,
            permissionId: tool.permissionId,
            risk: tool.risk,
            actionFamilyId: tool.actionFamilyId,
            executionPolicy: tool.executionPolicy,
            selfOperationGrant: tool.selfOperationGrant,
            requiresConfirmation,
            inputSchema: tool.inputSchema,
            isExternal: true,
            outputSchema: tool.outputSchema,
            classifier: synthesizeClassifier(module, tool, invokeCandidates),
            // The SDK types scopedDb as unknown; the gateway always passes a DataContextDb.
            execute: (scopedDb, input, context) =>
              invoke(module, tool, input, context, scopedDb as DataContextDb)
          };
        })
      };
      // Recompute the validated manifest hash before binding: mutation of even nested schema
      // or classifier text after discovery cannot inherit the accepted manifest's approval.
      if (hashCanonicalManifest(module.manifest) === module.manifestHash) {
        synthesizedSnapshots.set(manifest, {
          manifestHash: module.manifestHash,
          packageHash: module.packageHash,
          descriptorHash: hashCanonicalManifest(manifest)
        });
      }
      return manifest;
    });
}
