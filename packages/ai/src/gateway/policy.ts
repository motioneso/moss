import type {
  ModuleAssistantToolManifest,
  ModuleAssistantActionFamilyManifest,
  MossActionPermissionTier
} from "@moss/module-sdk";

export type PolicyDecision = "run" | "confirm";

export interface ActionPolicyLookup {
  getFamilyTier(moduleId: string, familyId: string): Promise<MossActionPermissionTier | null>;
  getFamilyManifest(
    moduleId: string,
    familyId: string
  ): Promise<ModuleAssistantActionFamilyManifest | null>;
}

export interface AgencyPrefLookup {
  get(key: string): Promise<unknown>;
  upsert?(key: string, value: unknown): Promise<void>;
}

/**
 * Reads run. Writes default to confirm unless the owning module explicitly
 * declares auto agency (or tier = trusted_auto) and the user promoted that module. Destructive
 * tools always confirm — as does any write tool whose `requiresConfirmation` hook resolved true
 * for this specific call (`confirmOverride`, computed by the caller before this function runs —
 * see gateway.ts's `computeConfirmOverride` — so this module stays DB-free), even when the
 * tool's family has been promoted to trusted_auto.
 */
export async function resolvePolicy(
  tool: ModuleAssistantToolManifest,
  moduleId: string,
  confirmOverride: boolean,
  lookup: ActionPolicyLookup
): Promise<PolicyDecision> {
  if (tool.risk === "read") return "run";
  if (tool.risk === "destructive") return "confirm";
  if (tool.risk === "outbound") return "confirm";
  if (confirmOverride) return "confirm";

  const familyId = tool.actionFamilyId;
  if (!familyId) {
    return "confirm";
  }

  const manifest = await lookup.getFamilyManifest(moduleId, familyId);
  if (!manifest) return "confirm";

  const tier = (await lookup.getFamilyTier(moduleId, familyId)) ?? manifest.defaultTier;
  if (
    tier === "trusted_auto" &&
    tool.executionPolicy === "auto" &&
    manifest.allowedTiers.includes("trusted_auto")
  ) {
    return "run";
  }

  return "confirm";
}
