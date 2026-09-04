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

export function moduleSettingsHref(moduleId: string): string {
  return `/settings?section=modules&module=${encodeURIComponent(moduleId)}`;
}
