import { todayNavEntry, webRoutePath } from "../app-route-metadata.js";
import type { ListThemesResponse, ModuleDto, ModuleNavigationEntryDto } from "@moss/shared";

export type CommandPaletteGroupLabel = "Navigate" | "Tasks" | "Appearance" | "Settings";

export type CommandPaletteAction =
  | { readonly kind: "navigate"; readonly to: string }
  | { readonly kind: "theme"; readonly themeId: string }
  | { readonly kind: "create-task" }
  | { readonly kind: "set-color-mode"; readonly mode: "light" | "dark" };

export interface CommandPaletteCommand {
  readonly id: string;
  readonly group: CommandPaletteGroupLabel;
  readonly label: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly icon: string | null;
  readonly action: CommandPaletteAction;
}

export interface CommandPaletteGroup {
  readonly label: CommandPaletteGroupLabel;
  readonly items: readonly CommandPaletteCommand[];
}

const GROUP_ORDER: readonly CommandPaletteGroupLabel[] = [
  "Navigate",
  "Tasks",
  "Appearance",
  "Settings"
] as const;
// "briefings" has no web route of its own -- Today covers it -- and "chat" isn't a page.
const PALETTE_HIDDEN_NAV_IDS = new Set(["chat", "briefings"]);

export function buildCommandPaletteCommands(input: {
  readonly modules: readonly ModuleDto[];
  readonly disabledModuleIds: readonly string[];
  readonly themes: ListThemesResponse | undefined;
  readonly assistantName: string;
}): readonly CommandPaletteCommand[] {
  const enabledModules = input.modules.filter(
    (module) => !input.disabledModuleIds.includes(module.id)
  );
  const commands: CommandPaletteCommand[] = [];
  const navEntries = paletteNavigationEntries(enabledModules);

  for (const entry of navEntries) {
    commands.push({
      id: `nav:${entry.id}`,
      group: "Navigate",
      label: entry.label,
      description: `Open ${entry.label}`,
      keywords: [entry.id, "go", "open", "page"],
      icon: entry.icon,
      action: { kind: "navigate", to: entry.path }
    });
  }

  if (hasModule(enabledModules, "tasks")) {
    commands.push(
      {
        id: "task:create",
        group: "Tasks",
        label: "Create task",
        description: "Choose a list, then add a title",
        keywords: ["task", "quick add", "capture", "todo", "new"],
        icon: "plus",
        action: { kind: "create-task" }
      },
      {
        id: "task:open",
        group: "Tasks",
        label: "Open Tasks",
        description: "Go to your task list",
        keywords: ["tasks", "todo", "plan"],
        icon: "check-square",
        action: { kind: "navigate", to: webRoutePath("tasks") }
      },
      {
        id: "task:settings",
        group: "Tasks",
        label: "Open task settings",
        description: "Open the tasks module setup surface",
        keywords: ["tasks", "settings", "lists", "preferences"],
        icon: "sliders-horizontal",
        action: { kind: "navigate", to: moduleSettingsHref("tasks") }
      }
    );
  }

  for (const theme of input.themes?.builtIn ?? []) {
    commands.push(themeCommand(theme.id, theme.name));
  }
  for (const theme of input.themes?.custom ?? []) {
    commands.push(themeCommand(theme.id, theme.name));
  }
  const activeThemeId = input.themes?.activeId;
  const activeIsBuiltIn =
    input.themes?.builtIn.some((theme) => theme.id === activeThemeId) ?? true;
  if (activeIsBuiltIn && input.themes) {
    const otherMode = input.themes.mode === "dark" ? "light" : "dark";
    commands.push({
      id: `mode:${otherMode}`,
      group: "Appearance",
      label: `Switch to ${otherMode} mode`,
      description: `Set color mode to ${otherMode}`,
      keywords: ["appearance", "theme", "color mode", "light", "dark"],
      icon: "palette",
      action: { kind: "set-color-mode", mode: otherMode }
    });
  }
  commands.push({
    id: "settings:appearance",
    group: "Appearance",
    label: "Open Appearance settings",
    description: "Adjust themes and colors",
    keywords: ["appearance", "theme", "colors", "settings"],
    icon: "palette",
    action: { kind: "navigate", to: settingsSectionHref("appearance") }
  });

  commands.push(
    {
      id: "settings:root",
      group: "Settings",
      label: "Open Settings",
      description: "Open settings and permissions",
      keywords: ["settings", "preferences", "account"],
      icon: "settings",
      action: { kind: "navigate", to: webRoutePath("settings") }
    },
    {
      id: "settings:modules",
      group: "Settings",
      label: "Open Modules settings",
      description: "Configure enabled modules",
      keywords: ["settings", "modules", "features"],
      icon: "boxes",
      action: { kind: "navigate", to: settingsSectionHref("modules") }
    },
    {
      id: "settings:connected",
      group: "Settings",
      label: "Open connected accounts",
      description: "Manage your external accounts",
      keywords: ["settings", "accounts", "connectors", "google"],
      icon: "link-2",
      action: { kind: "navigate", to: settingsSectionHref("connected") }
    },
    {
      id: "settings:sources",
      group: "Settings",
      label: "Open data sources",
      description: `Choose what ${input.assistantName} can read`,
      keywords: ["settings", "sources", "email", "calendar", "notes"],
      icon: "database",
      action: { kind: "navigate", to: settingsSectionHref("sources") }
    }
  );

  if (hasModule(enabledModules, "notifications")) {
    commands.push({
      id: "settings:notifications",
      group: "Settings",
      label: "Open notifications settings",
      description: "Configure notification behavior",
      keywords: ["settings", "notifications", "alerts"],
      icon: "bell",
      action: { kind: "navigate", to: moduleSettingsHref("notifications") }
    });
  }

  return commands;
}

export function filterCommandPaletteCommands(
  commands: readonly CommandPaletteCommand[],
  query: string
): readonly CommandPaletteGroup[] {
  const needle = query.trim().toLowerCase();
  const visible = !needle
    ? commands
    : commands.filter((command) => {
        const haystack = [command.label, command.description, ...command.keywords]
          .join(" ")
          .toLowerCase();
        return haystack.includes(needle);
      });

  return GROUP_ORDER.map((label) => ({
    label,
    items: visible.filter((command) => command.group === label)
  })).filter((group) => group.items.length > 0);
}

export function settingsSectionHref(section: string): string {
  return `/settings?section=${encodeURIComponent(section)}`;
}

export function moduleSettingsHref(moduleId: string): string {
  return `/settings?section=modules&module=${encodeURIComponent(moduleId)}`;
}

function paletteNavigationEntries(
  modules: readonly ModuleDto[]
): readonly ModuleNavigationEntryDto[] {
  const entryById = new Map<string, ModuleNavigationEntryDto>();
  entryById.set(todayNavEntry.id, todayNavEntry);
  entryById.set("settings", {
    id: "settings",
    label: "Settings",
    path: webRoutePath("settings"),
    icon: "settings",
    order: Number.MAX_SAFE_INTEGER
  });

  for (const module of modules) {
    for (const entry of module.navigation) {
      if (PALETTE_HIDDEN_NAV_IDS.has(entry.id)) continue;
      entryById.set(entry.id, entry);
    }
  }

  return [...entryById.values()].sort((left, right) => {
    if (left.id === "today" || right.id === "today") return left.id === "today" ? -1 : 1;
    if (left.id === "settings" || right.id === "settings") return left.id === "settings" ? 1 : -1;
    const leftOrder = left.order ?? Number.MAX_SAFE_INTEGER;
    const rightOrder = right.order ?? Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder || left.label.localeCompare(right.label);
  });
}

function hasModule(modules: readonly ModuleDto[], moduleId: string): boolean {
  return modules.some((module) => module.id === moduleId);
}

function themeCommand(id: string, name: string): CommandPaletteCommand {
  return {
    id: `theme:${id}`,
    group: "Appearance",
    label: `Switch to ${name}`,
    description: `${name} theme`,
    keywords: ["theme", "appearance", "color", name],
    icon: "palette",
    action: { kind: "theme", themeId: id }
  };
}
