export type ShellNavMode = "expanded" | "rail";

export const SHELL_NAV_STORAGE_KEY = "jarvis.nav:v1";

type NavStorage = Pick<Storage, "getItem" | "setItem">;

export function loadShellNav(storage: NavStorage = localStorage): ShellNavMode {
  try {
    const stored = storage.getItem(SHELL_NAV_STORAGE_KEY)?.trim();
    if (stored === "rail") return "rail";
    return "expanded";
  } catch {
    return "expanded";
  }
}

export function saveShellNav(mode: ShellNavMode, storage: NavStorage = localStorage): void {
  try {
    storage.setItem(SHELL_NAV_STORAGE_KEY, mode);
  } catch {
    // Storage can be disabled, full, or unavailable in private browsing.
  }
}
