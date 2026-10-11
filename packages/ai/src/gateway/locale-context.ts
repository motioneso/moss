import type { ToolContext, ToolLocale } from "@moss/module-sdk";
import type { LocaleSettingsDto } from "@moss/shared";

/** The ToolContext fields that carry the person's locale; empty when it is unknown. */
export function localeContext(
  locale: ToolLocale | undefined
): Pick<ToolContext, "locale" | "localTimezone"> {
  return locale ? { locale, localTimezone: locale.timezone } : {};
}

/** The module SDK cannot import the shared package, so its copy must stay identical. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const toolLocaleMatchesSettings: Same<ToolLocale, LocaleSettingsDto> = true;
void toolLocaleMatchesSettings;
