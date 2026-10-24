declare module "virtual:moss-module-settings" {
  import type { LazyExoticComponent, ComponentType } from "react";
  import type { GeneratedSettingsSurface, ModuleSettingsSurfaceProps } from "@moss/settings-ui";

  export const MODULE_SETTINGS_SURFACES: readonly GeneratedSettingsSurface[];
  export const MODULE_SETTINGS_COMPONENTS: Readonly<
    Record<string, LazyExoticComponent<ComponentType<ModuleSettingsSurfaceProps>>>
  >;
  export const MODULE_SETTING_KEYWORDS: Readonly<Record<string, readonly string[]>>;
}

declare module "virtual:moss-module-web" {
  import type { ModuleVisualTemplate } from "@moss/module-sdk/visual-template";
  import type { ComponentType } from "react";
  import type { VisualSnapshotV1 } from "@moss/shared";
  import type {
    ModulePersistentControlsContribution,
    ModuleWebContribution
  } from "@moss/module-web-sdk";

  export interface GeneratedWebRoute {
    readonly moduleId: string;
    readonly moduleName: string;
    readonly id: string;
    readonly label: string;
    readonly path: string;
    readonly icon: string | null;
    readonly order: number | null;
    readonly permissionId: string | null;
  }

  export interface ModuleWebContributionEntry {
    readonly moduleId: string;
    readonly load: () => Promise<{ readonly default: ModuleWebContribution }>;
  }

  export interface ModulePersistentControlsEntry {
    readonly moduleId: string;
    readonly load: () => Promise<{ readonly default: ModulePersistentControlsContribution }>;
  }

  export const MODULE_VISUAL_CONTRACTS: readonly ModuleVisualTemplate[];
  export const MODULE_VISUAL_RENDERERS: readonly (() => Promise<{
    default: Readonly<Record<string, ComponentType<{ snapshot: VisualSnapshotV1 }>>>;
  }>)[];
  export const MODULE_PERSISTENT_CONTROLS: readonly ModulePersistentControlsEntry[];
  export const MODULE_WEB_ROUTES: readonly GeneratedWebRoute[];
  export const MODULE_WEB_CONTRIBUTIONS: readonly ModuleWebContributionEntry[];
}
