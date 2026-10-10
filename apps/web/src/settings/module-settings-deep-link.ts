export type ModuleSettingsDeepLink =
  | "briefings"
  | "notifications"
  | { readonly moduleId: string }
  | null;

export function resolveModuleSettingsDeepLink(
  requested: string | null,
  hasContributedSurface: (moduleId: string) => boolean
): ModuleSettingsDeepLink {
  if (!requested) return null;
  if (requested === "briefings" || requested === "notifications") {
    return requested;
  }
  if (hasContributedSurface(requested)) {
    return { moduleId: requested };
  }
  return null;
}

/**
 * Where a module's settings live. A module that declares its own settings page (`settingsPath`
 * on its entry in the module list, #3184) gets that page; every other module gets its section
 * of the host Settings page.
 */
export function moduleSettingsHref(
  moduleId: string,
  modules: readonly { readonly id: string; readonly settingsPath?: string }[] = []
): string {
  const own = modules.find((module) => module.id === moduleId)?.settingsPath;
  if (own) return own;
  return `/settings?section=modules&module=${encodeURIComponent(moduleId)}`;
}
