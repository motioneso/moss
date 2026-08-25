import { describe, expect, it } from "vitest";

import {
  buildCommandPaletteCommands,
  filterCommandPaletteCommands,
  moduleSettingsHref
} from "../../apps/web/src/shell/command-palette-model.js";
import type { ModuleDto } from "@moss/shared";

describe("command palette model", () => {
  it("builds grouped commands from real shell routes, themes, and safe settings targets", () => {
    const commands = buildCommandPaletteCommands({
      assistantName: "Alfred",
      modules: [
        moduleWithNav("tasks", "Tasks", "/tasks", "check-square", 20),
        moduleWithNav("calendar", "Calendar", "/calendar", "calendar-days", 30),
        moduleWithNav("briefings", "Briefings", "/briefings", "newspaper", 40),
        moduleWithNav("notifications", "Notifications", "/notifications", "bell", 50),
        moduleWithNav("wellness", "Wellness", "/wellness", "heart-pulse", 60),
        moduleWithNav("chat", "Chat", "/chat", "message-square", 70)
      ],
      disabledModuleIds: ["wellness"],
      themes: {
        activeId: "light",
        mode: "light",
        builtIn: [
          { id: "light", name: "Forest", builtIn: true },
          { id: "sage", name: "Sage", builtIn: true },
          { id: "canyon", name: "Canyon", builtIn: true },
          { id: "teal", name: "Teal", builtIn: true },
          { id: "dusk", name: "Dusk", builtIn: true },
          { id: "dark", name: "Dark", builtIn: true }
        ],
        custom: [
          {
            id: "night-owl",
            name: "Night Owl",
            builtIn: false,
            tokens: {
              paper: "#101010",
              surface: "#111111",
              surface2: "#121212",
              surface3: "#131313",
              ink: "#f0f0f0",
              ink2: "#dddddd",
              ink3: "#cccccc",
              ink4: "#bbbbbb",
              line: "#222222",
              lineSubtle: "#232323",
              lineStrong: "#242424",
              accent: "#4e9fff"
            }
          }
        ]
      }
    });

    expect(
      commands.filter((command) => command.group === "Navigate").map((command) => command.id)
    ).toEqual(["nav:today", "nav:tasks", "nav:calendar", "nav:notifications", "nav:settings"]);

    expect(
      commands.filter((command) => command.group === "Tasks").map((command) => command.id)
    ).toEqual(["task:create", "task:open", "task:settings"]);

    expect(
      commands.filter((command) => command.group === "Appearance").map((command) => command.id)
    ).toEqual([
      "theme:light",
      "theme:sage",
      "theme:canyon",
      "theme:teal",
      "theme:dusk",
      "theme:dark",
      "theme:night-owl",
      "mode:dark",
      "settings:appearance"
    ]);

    expect(
      commands.filter((command) => command.group === "Settings").map((command) => command.id)
    ).toEqual([
      "settings:root",
      "settings:modules",
      "settings:connected",
      "settings:sources",
      "settings:notifications"
    ]);

    expect(commands.some((command) => command.id === "nav:wellness")).toBe(false);
    expect(
      commands.filter(
        (command) =>
          command.action.kind === "navigate" && command.action.to === moduleSettingsHref("tasks")
      )
    ).toHaveLength(1);
  });

  it("filters by label, description, and aliases while preserving group order", () => {
    const commands = buildCommandPaletteCommands({
      assistantName: "Alfred",
      modules: [moduleWithNav("tasks", "Tasks", "/tasks", "check-square", 20)],
      disabledModuleIds: [],
      themes: {
        activeId: "dark",
        mode: "dark",
        builtIn: [{ id: "dark", name: "Dark", builtIn: true }],
        custom: []
      }
    });

    expect(filterCommandPaletteCommands(commands, "").map((group) => group.label)).toEqual([
      "Navigate",
      "Tasks",
      "Appearance",
      "Settings"
    ]);

    expect(filterCommandPaletteCommands(commands, "accounts")).toEqual([
      expect.objectContaining({
        label: "Settings",
        items: [expect.objectContaining({ id: "settings:connected" })]
      })
    ]);

    expect(filterCommandPaletteCommands(commands, "quick add")).toEqual([
      expect.objectContaining({
        label: "Tasks",
        items: [expect.objectContaining({ id: "task:create" })]
      })
    ]);
  });

  // #1441 — the data-sources description names the assistant, so it has to come
  // from the caller's configured name. A hardcoded literal here would still pass
  // a test that only checked the command exists.
  it("names the configured assistant in the data-sources description", () => {
    const commands = buildCommandPaletteCommands({
      assistantName: "Alfred",
      modules: [],
      disabledModuleIds: [],
      themes: {
        activeId: "dark",
        mode: "dark",
        builtIn: [{ id: "dark", name: "Dark", builtIn: true }],
        custom: []
      }
    });

    const sources = commands.find((item) => item.id === "settings:sources");

    expect(sources?.description).toBe("Choose what Alfred can read");
  });
});

function moduleWithNav(
  id: string,
  label: string,
  path: string,
  icon: string,
  order: number
): ModuleDto {
  return {
    id,
    name: label,
    version: "0.0.0",
    lifecycle: "optional",
    navigation: [{ id, label, path, icon, order }],
    settings: []
  };
}
