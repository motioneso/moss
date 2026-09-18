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

/**
 * Whether unattended mode may run this tool with no card: only when a person
 * could have promoted the tool's family to run automatically (#2418, #2419).
 * Reads off the family's allowed tiers, never the stored tier, and fails closed —
 * destructive tools, outbound tools, missing family, non-auto tool, or an unreadable
 * manifest means the card.
 */
export async function familyAllowsAutoRun(
  tool: ModuleAssistantToolManifest,
  moduleId: string,
  lookup: ActionPolicyLookup
): Promise<boolean> {
  if (tool.risk === "destructive" || tool.risk === "outbound") return false;
  const familyId = tool.actionFamilyId;
  if (!familyId || tool.executionPolicy !== "auto") return false;
  const manifest = await lookup.getFamilyManifest(moduleId, familyId);
  return manifest?.allowedTiers.includes("trusted_auto") ?? false;
}

export const TASKS_FIRST_RUN_NOTICE_KEY = "tasks.agency_auto_execute.first_prompt_seen";
export const TASKS_FIRST_RUN_NOTICE =
  'Your assistant now asks before creating tasks. Enable "create without asking" in Task settings to auto-run task changes.';

export function createEffectivePolicyLookup(
  lookup: ActionPolicyLookup,
  resolveActiveModules: (actorUserId: string) => Promise<
    readonly {
      id: string;
      assistantActionFamilies?: readonly ModuleAssistantActionFamilyManifest[];
    }[]
  >,
  actorUserId: string
): ActionPolicyLookup {
  return {
    getFamilyTier: (modId, famId) => lookup.getFamilyTier(modId, famId),
    getFamilyManifest: async (modId, famId) => {
      const fromLookup = await lookup.getFamilyManifest(modId, famId);
      if (fromLookup) return fromLookup;
      try {
        const activeModules = await resolveActiveModules(actorUserId);
        const moduleManifest = activeModules.find((m) => m.id === modId);
        return moduleManifest?.assistantActionFamilies?.find((f) => f.id === famId) ?? null;
      } catch {
        return null;
      }
    }
  };
}

export async function resolveFirstRunNotice(
  moduleId: string,
  tool: ModuleAssistantToolManifest,
  prefs: AgencyPrefLookup
): Promise<string | undefined> {
  if (
    moduleId !== "tasks" ||
    tool.risk !== "write" ||
    tool.executionPolicy !== "auto" ||
    !prefs.upsert
  ) {
    return undefined;
  }
  try {
    if ((await prefs.get(TASKS_FIRST_RUN_NOTICE_KEY)) === true) return undefined;
    await prefs.upsert(TASKS_FIRST_RUN_NOTICE_KEY, true);
    return TASKS_FIRST_RUN_NOTICE;
  } catch {
    return undefined;
  }
}

export function summarizeToolAction(
  tool: ModuleAssistantToolManifest,
  input: Record<string, unknown>,
  ctx: { actorUserId: string; requestId: string; chatSessionId: string; localTimezone?: string }
): string {
  if (typeof tool.summarize === "function") {
    return tool.summarize(input, ctx);
  }
  return tool.actionLabel ?? tool.name;
}
