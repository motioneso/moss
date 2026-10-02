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

import type { ExternalModuleDiscovery } from "./types.js";

export type ExternalToolInvoker = (
  module: ExternalModuleDiscovery,
  tool: ExternalModuleAssistantToolDeclaration,
  input: ToolInput,
  context: ToolContext
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

function synthesizeRequiresConfirmation(
  tool: ExternalModuleAssistantToolDeclaration
): ToolRequiresConfirmation | undefined {
  if (!tool.confirmWhen?.length && !tool.confirmWhenKeys?.length) return undefined;
  return (_scopedDb, input) =>
    tool.confirmWhenKeys?.some((key) => Object.hasOwn(input, key)) === true ||
    tool.confirmWhen?.some(
      ({ key, equals }) => Object.hasOwn(input, key) && input[key] === equals
    ) === true;
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
  invokeCandidates?: ExternalCandidateInvoker
): MossModuleManifest[] {
  return discoveries
    .filter((module) => module.manifest.runtime && module.manifest.assistantTools?.length)
    .map((module) => ({
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
        const requiresConfirmation = synthesizeRequiresConfirmation(tool);
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
          execute: (_scopedDb, input, context) => invoke(module, tool, input, context)
        };
      })
    }));
}
