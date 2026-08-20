import { describe, expect, it } from "vitest";

import {
  buildShellNavigation,
  resolvePageHeading,
  webRoutes
} from "../../apps/web/src/app-route-metadata.js";
import { CORE_APP_SCREENS, type ModuleDto } from "@moss/shared";

describe("web route metadata", () => {
  it("keeps shell navigation policy in route metadata instead of AppShell conditionals", () => {
    const modules: ModuleDto[] = [
      moduleWithNav("tasks", "Tasks", "/tasks", "check-square", 20),
      moduleWithNav("chat", "Chat", "/chat", "message-square", 30),
      moduleWithNav("settings", "Settings", "/settings", "settings", 40),
      moduleWithNav("wellness", "Wellness", "/wellness", "heart-pulse", 50)
    ];

    const sections = buildShellNavigation(modules, []);
    expect(sections.map((section) => section.key)).toEqual(["__top", "Plan", "You"]);
    expect(sections[0]?.items.map((item) => item.id)).toEqual(["today"]);
    expect(sections.flatMap((section) => section.items.map((item) => item.id))).toEqual([
      "today",
      "tasks",
      "wellness"
    ]);
  });

  // #1734: the group still exists and still sits last — what changed is that it renders with no
  // header. "Modules" is our word for how the software is assembled; to someone using Moss, Food
  // is just Food. Asserting `label` is null is the whole point: a rename would pass a test that
  // only checked the grouping.
  it("keeps installed entries in their own group at the end, with no header", () => {
    const modules: ModuleDto[] = [
      moduleWithNav("tasks", "Tasks", "/tasks", "check-square", 20),
      moduleWithNav("wellness", "Wellness", "/wellness", "heart-pulse", 50),
      moduleWithNav("demo-module", "Demo Module", "/m/demo-module", "briefcase", 0, true)
    ];

    const sections = buildShellNavigation(modules, []);
    expect(sections.map((section) => section.key)).toEqual(["__top", "Plan", "You", "__installed"]);
    const modulesSection = sections.find((section) => section.key === "__installed");
    expect(modulesSection?.label).toBeNull();
    expect(modulesSection?.items).toEqual([
      {
        id: "demo-module",
        label: "Demo Module",
        path: "/m/demo-module",
        icon: "briefcase",
        order: 0
      }
    ]);
  });

  it("never lets an external module's entry consult SECTION_OF even if its id collides with a built-in section key", () => {
    const modules: ModuleDto[] = [
      moduleWithNav("wellness", "Fake Wellness", "/m/wellness", "briefcase", 0, true)
    ];
    const sections = buildShellNavigation(modules, []);
    const you = sections.find((section) => section.key === "You");
    const modulesSection = sections.find((section) => section.key === "__installed");
    expect(you).toBeUndefined();
    expect(modulesSection?.items.map((item) => item.id)).toEqual(["wellness"]);
  });

  it("derives page headings from the same route table", () => {
    expect(resolvePageHeading("/today", new Date("2026-06-14T16:42:00Z")).title).toBe("Today");
    expect(resolvePageHeading("/settings", new Date("2026-06-14T16:42:00Z"))).toMatchObject({
      title: "Settings & permissions",
      subtitle: ""
    });
  });

  it("uses a runtime external module label for its embedded route heading", () => {
    expect(
      resolvePageHeading("/m/demo-module/onboarding", new Date("2026-06-14T16:42:00Z"), undefined, [
        moduleWithNav("demo-module", "Demo Module", "/m/demo-module", "briefcase", 0, true)
      ])
    ).toEqual({ title: "Demo Module", subtitle: "" });
  });

  it("defines concrete app routes without synthetic shell-only entries", () => {
    expect(webRoutes.map((route) => route.path)).toEqual([
      "/today",
      "/tasks",
      "/notifications",
      "/calendar",
      "/wellness",
      "/news",
      "/sports",
      "/settings"
    ]);
  });

  it("keeps every core app-map screen reachable by web route metadata", () => {
    const routeIds = new Set(webRoutes.map((route) => route.id));
    expect(CORE_APP_SCREENS.map((surface) => surface.id).filter((id) => !routeIds.has(id))).toEqual(
      []
    );
  });
});

function moduleWithNav(
  id: string,
  label: string,
  path: string,
  icon: string,
  order: number,
  external = false
): ModuleDto {
  return {
    id,
    name: label,
    version: "0.0.0",
    lifecycle: "optional",
    navigation: [{ id, label, path, icon, order }],
    settings: [],
    ...(external ? { external: true } : {})
  };
}
