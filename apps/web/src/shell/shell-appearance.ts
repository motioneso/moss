import type { ListThemesResponse } from "@moss/shared";
import { isDarkThemeColor } from "../theme/theme-runtime";
import type { ShellColorMode } from "./theme-storage";

export interface ShellAppearance {
  readonly themeId: string;
  readonly dataTheme: string;
  readonly colorMode: ShellColorMode;
  readonly tokens: ListThemesResponse["custom"][number]["tokens"] | null;
  /** Whether the page renders dark, custom themes included. The boot script reads it. */
  readonly pageTone: ShellColorMode;
}

/** What the shell applies to the document once the server's theme list has loaded. */
export function resolveShellAppearance(themes: ListThemesResponse): ShellAppearance {
  const themeId = themes.activeId;
  const customTheme = themes.custom.find((custom) => custom.id === themeId) ?? null;

  // Custom themes carry their own colours, so they always render on the light base.
  const colorMode = customTheme ? "light" : themes.mode;
  const dataTheme = customTheme ? themeId : themeId === "dark" ? "light" : themeId;
  const customDark = customTheme ? isDarkThemeColor(customTheme.tokens.paper) : null;
  const pageTone = customDark === null ? colorMode : customDark ? "dark" : "light";

  return { themeId, dataTheme, colorMode, tokens: customTheme?.tokens ?? null, pageTone };
}
