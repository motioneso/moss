import type { ToolContext, ToolLocale } from "@moss/module-sdk";

/** The ToolContext fields that carry the person's locale; empty when it is unknown. */
export function localeContext(
  locale: ToolLocale | undefined
): Pick<ToolContext, "locale" | "localTimezone"> {
  return locale ? { locale, localTimezone: locale.timezone } : {};
}
