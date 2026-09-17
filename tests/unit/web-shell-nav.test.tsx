import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";

import type { MeResponse } from "@moss/shared";
import {
  loadShellNav,
  saveShellNav,
  SHELL_NAV_STORAGE_KEY
} from "../../apps/web/src/shell/nav-storage.js";

const { ShellNav } = await import("../../apps/web/src/shell/shell-nav.js");

describe("shell nav storage", () => {
  it("uses a versioned storage key and defaults to expanded", () => {
    expect(SHELL_NAV_STORAGE_KEY).toBe("jarvis.nav:v1");
    expect(loadShellNav(memoryStorage())).toBe("expanded");
    expect(loadShellNav(storageThatThrowsOnRead())).toBe("expanded");
  });

  it("round-trips the rail preference and ignores write failures", () => {
    const storage = memoryStorage();
    saveShellNav("rail", storage);
    expect(storage.getItem(SHELL_NAV_STORAGE_KEY)).toBe("rail");
    expect(loadShellNav(storage)).toBe("rail");
    saveShellNav("expanded", storage);
    expect(loadShellNav(storage)).toBe("expanded");
    expect(() => saveShellNav("rail", storageThatThrowsOnWrite())).not.toThrow();
  });

  it("treats unknown stored values as expanded", () => {
    const storage = memoryStorage();
    storage.setItem(SHELL_NAV_STORAGE_KEY, "narrow");
    expect(loadShellNav(storage)).toBe("expanded");
  });
});

describe("shell nav rail rendering", () => {
  it("keeps every destination named and marks the toggle in rail mode", () => {
    const html = renderShellNav("rail");
    expect(html).toContain('aria-label="Expand navigation"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Today"');
    expect(html).toContain('title="Today"');
    expect(html).toContain('aria-label="Tasks"');
    expect(html).toContain('title="Tasks"');
  });

  it("places the collapse control beside the logo, before destinations", () => {
    for (const mode of ["expanded", "rail"] as const) {
      const html = renderShellNav(mode);
      const buttonIdx = html.indexOf("nav-collapse");
      const navIdx = html.indexOf("<nav");
      expect(buttonIdx).toBeGreaterThan(-1);
      expect(navIdx).toBeGreaterThan(-1);
      expect(buttonIdx).toBeLessThan(navIdx);
    }
    const expanded = renderShellNav("expanded");
    expect(expanded).not.toContain("PanelLeft");
    expect(expanded).toContain("chevrons-left");
    expect(renderShellNav("rail")).toContain("chevrons-right");
  });

  it("offers collapse with no per-link labels in expanded mode", () => {
    const html = renderShellNav("expanded");
    expect(html).toContain('aria-label="Collapse navigation"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain('aria-label="Today"');
  });
});

const ME: MeResponse = {
  user: {
    id: "user-1",
    email: "ben@example.com",
    emailVerified: true,
    name: "Ben",
    isInstanceAdmin: false,
    status: "active",
    isBootstrapOwner: false,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString()
  },
  profilePrefs: { addressed: null },
  hasPasswordCredential: true
};

function renderShellNav(navMode: "expanded" | "rail"): string {
  return renderToString(
    createElement(
      MemoryRouter,
      { initialEntries: ["/today"] },
      createElement(ShellNav, {
        navMode,
        onToggleNav: () => {},
        mobileNavOpen: false,
        closeMobileNav: () => {},
        openNavButtonRef: { current: null },
        me: ME,
        modulesLoading: false,
        navSections: [
          {
            key: "top",
            label: null,
            items: [
              { id: "today", label: "Today", path: "/today", icon: "house", order: -1 },
              { id: "tasks", label: "Tasks", path: "/tasks", icon: "check-square", order: 1 }
            ]
          }
        ],
        unreadByModule: {},
        unreadCount: 0,
        signOutPending: false,
        onSignOut: () => {},
        onNavigate: () => {}
      })
    )
  );
}

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    }
  };
}

function storageThatThrowsOnRead(): Pick<Storage, "getItem" | "setItem"> {
  return {
    getItem: () => {
      throw new Error("storage disabled");
    },
    setItem: () => {}
  };
}

function storageThatThrowsOnWrite(): Pick<Storage, "getItem" | "setItem"> {
  return {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota exceeded");
    }
  };
}
