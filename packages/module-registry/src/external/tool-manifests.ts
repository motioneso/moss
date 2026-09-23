import type {
  ExternalModuleAssistantToolDeclaration,
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

export function createExternalToolManifests(
  discoveries: readonly ExternalModuleDiscovery[],
  invoke: ExternalToolInvoker
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
          execute: (_scopedDb, input, context) => invoke(module, tool, input, context)
        };
      })
    }));
}
