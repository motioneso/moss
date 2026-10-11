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
 *
 * `sortedSafe` is the connected tool's `runsWithoutAsking` result for this call (#2984, spec 8.3),
 * also computed by the caller. It runs an external tool unless a confirmation override applies,
 * so a first-party outbound tool still confirms.
 * A composition-owned per-call resolver has already authorized an ordinary app write when
 * `perCallResolved` is true; it needs no mutable action-family tier. All confirmation floors
 * above that ordinary-write rule still apply.
 *
 * A tainted conversation (#3338) keeps only the user's own trust: a promoted family still runs,
 * and its `confirmOverride` limit still applies. Moss's own ratings (`sortedSafe`, per-call app
 * writes) ask, as do outbound tools and any `confirmWhenTainted` call.
 */
export async function resolvePolicy(
  tool: ModuleAssistantToolManifest,
  moduleId: string,
  confirmOverride: boolean,
  lookup: ActionPolicyLookup,
  sortedSafe = false,
  perCallResolved = false,
  conversationTainted = false,
  confirmWhenTainted = false
): Promise<PolicyDecision> {
  if (conversationTainted && confirmWhenTainted) return "confirm";
  if (tool.risk === "read") return "run";
  if (tool.risk === "destructive") return "confirm";
  if (sortedSafe && tool.isExternal === true && !conversationTainted) {
    return confirmOverride ? "confirm" : "run";
  }
  if (tool.risk === "outbound") return "confirm";
  if (confirmOverride) return "confirm";
  if (perCallResolved) return conversationTainted ? "confirm" : "run";

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
 * installed-module tools whose family allows only always_confirm, destructive tools, outbound tools, a declared family that is missing or unreadable, or a non-auto tool
 * means the card. An external tool that declares no family runs. A server-resolved ordinary app write needs no family promotion;
 * its route-level authorization has already been checked before reaching this helper.
 */
export async function familyAllowsAutoRun(
  tool: ModuleAssistantToolManifest,
  moduleId: string,
  lookup: ActionPolicyLookup,
  perCallResolved = false
): Promise<boolean> {
  if (tool.risk === "destructive") return false;
  const familyId = tool.actionFamilyId;
  if (tool.isExternal === true) {
    if (!familyId) return true;
    const external = await lookup.getFamilyManifest(moduleId, familyId);
    // A declared family that cannot be read means ask, never run.
    return external?.allowedTiers.includes("trusted_auto") ?? false;
  }
  if (tool.risk === "outbound") return false;
  if (perCallResolved) return true;
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
