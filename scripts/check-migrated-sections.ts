import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BANNED_VISUAL_PROPERTIES } from "./check-design-tokens.js";

/**
 * Guards 5 and 6 (#1388 Foundation, docs/superpowers/specs/2026-08-03-ui-consolidation.md).
 *
 * Guard 1 (check-ui-classes.ts) only checks that a literal `jds-*` class is DEFINED somewhere —
 * `className="jds-btn jds-btn--primary"` passes it even though the point of a section's migration
 * is to render `<Button>` from @moss/ui instead of hand-typing the class. Guard 5 flags a raw
 * `jds-*` string in a migrated section's TSX **only when a component backing that class family is
 * exported from packages/ui/src/index.ts** — e.g. `jds-btn`/`jds-badge` are violations because
 * `Button`/`Badge` exist, but `jds-brief`/`jds-task`/`jds-drift`/`jds-check`/`jds-why` stay legal as
 * raw strings because no component backs them. This is a ruling, not a guess:
 * https://github.com/motioneso/Jarv1s/issues/1387#issuecomment-5182500821 — decided once for all
 * nine sections, do not re-litigate it per section. The class-to-component mapping is resolved
 * explicitly via CLASS_FAMILY_TO_COMPONENT below, never inferred from the class name by string
 * munging, so a family with no matching component can't silently pass.
 *
 * Guard 6 covers the same section's inline styles (`style={{...}}`), which evade both guard 1 (not
 * a className) and check-design-tokens.ts (not a CSS file) — a migrated section could otherwise
 * hard-code a colour in JSX and pass every other guard. Reuses BANNED_VISUAL_PROPERTIES (D2):
 * layout properties (position, spacing, grid, flex) stay legal inline.
 *
 * MIGRATED_SECTION_PATHS starts empty: Foundation converts no screens (spec "Section 1 —
 * Foundation... No screen changes"). Each section's own task issue (calendar first per D7) adds
 * its TSX file paths here once that section's migration PR lands — same day-one-empty,
 * burn-down-owned-by-each-section treatment as check-ui-classes.ts's guards 1/2.
 */

const rootDirectory = process.cwd();

export const MIGRATED_SECTION_PATHS: readonly string[] = [
  "apps/web/src/calendar/calendar-page.tsx",
  "apps/web/src/calendar/calendar-month.tsx",
  "apps/web/src/calendar/calendar-time-grid.tsx",
  "apps/web/src/calendar/calendar-peek.tsx",
  "apps/web/src/today/briefing-feedback-menu.tsx",
  "apps/web/src/today/briefing-freshness.tsx",
  "apps/web/src/today/brief-task-row.tsx",
  "apps/web/src/today/evening-mode.tsx",
  "apps/web/src/today/goals-section.tsx",
  "apps/web/src/today/header-weather.tsx",
  "apps/web/src/today/module-today-widgets.tsx",
  "apps/web/src/today/news-desk.tsx",
  "apps/web/src/today/overnight-section.tsx",
  "apps/web/src/today/proactive-cards.tsx",
  "apps/web/src/today/today-page.tsx",
  "apps/web/src/chat/action-request-card.tsx",
  "apps/web/src/chat/answer-provenance.tsx",
  "apps/web/src/chat/assistant-surface/surface.tsx",
  "apps/web/src/chat/chat-drawer.tsx",
  "apps/web/src/chat/chat-model-pill.tsx",
  "apps/web/src/chat/composer.tsx",
  "apps/web/src/chat/connect-provider-empty.tsx",
  "apps/web/src/chat/markdown-message.tsx",
  "apps/web/src/chat/message-row.tsx",
  "apps/web/src/chat/skill-autocomplete.tsx",
  "apps/web/src/onboarding/api-key-opt-out-step.tsx",
  "apps/web/src/onboarding/cli-auth-step.tsx",
  "apps/web/src/onboarding/connector-step.tsx",
  "apps/web/src/onboarding/google-connector-step.tsx",
  "apps/web/src/onboarding/member-connector-step.tsx",
  "apps/web/src/onboarding/member-welcome-step.tsx",
  "apps/web/src/onboarding/onboarding-ui.tsx",
  "apps/web/src/onboarding/onboarding-wizard.tsx",
  "apps/web/src/onboarding/section-tour-step.tsx",
  "apps/web/src/onboarding/skip-confirm.tsx",
  "apps/web/src/onboarding/welcome-step.tsx",
  // #1392 Wellness.
  "apps/web/src/wellness/checkin-detail-fields.tsx",
  "apps/web/src/wellness/checkin-modal.tsx",
  "apps/web/src/wellness/export-modal.tsx",
  "apps/web/src/wellness/manage-meds-modal.tsx",
  "apps/web/src/wellness/radial-dial.tsx",
  "apps/web/src/wellness/wellness-chart.tsx",
  "apps/web/src/wellness/wellness-history.tsx",
  "apps/web/src/wellness/wellness-insights.tsx",
  "apps/web/src/wellness/wellness-page.tsx",
  "apps/web/src/wellness/wellness-therapy-notes.tsx",
  "apps/web/src/wellness/wellness-today.tsx",
  "apps/web/src/wellness/wellness-trends.tsx",
  // #1393 Tasks + notifications.
  "apps/web/src/tasks/task-capture.tsx",
  "apps/web/src/tasks/task-details-dialog.tsx",
  "apps/web/src/tasks/task-details-sections.tsx",
  "apps/web/src/tasks/task-list-view.tsx",
  "apps/web/src/tasks/task-matrix-view.tsx",
  "apps/web/src/tasks/tasks-page.tsx",
  "apps/web/src/notifications/notifications-page.tsx",
  // #1394 Shipped modules: the news settings pane, whose 13 raw jds-btn elements became <Button>.
  // Sports migrated CSS only (no TSX changed), so its .tsx files are deliberately absent — see the
  // PR body. Note guard 5 is inert across both packages either way: the only raw jds-* strings
  // remaining in packages/news and packages/sports are jds-brief and jds-input, and neither family
  // is in CLASS_FAMILY_TO_COMPONENT. Guard 6 (inline styles) is what these entries actually buy.
  "packages/news/src/settings/add-source.tsx",
  "packages/news/src/settings/describe-topics.tsx",
  "packages/news/src/settings/index.tsx",
  // #1395 Settings: every apps/web/src/settings/*.tsx file touched by this section's Button/
  // Dialog/IconButton/Segmented/Badge conversions (Tasks 1-3e) or the pine->forest rename/inline-
  // style burn-down. packages/settings-ui's router/scanner/vite/priority half is #983's territory,
  // out of scope here and deliberately absent, same treatment as #1394's sports CSS-only files.
  "apps/web/src/settings/delete-account.tsx",
  "apps/web/src/settings/module-credentials-section.tsx",
  "apps/web/src/settings/settings-activity-pane.tsx",
  "apps/web/src/settings/settings-admin-panes.tsx",
  "apps/web/src/settings/settings-ai-admin-pane.tsx",
  "apps/web/src/settings/settings-ai-edit-model-form.tsx",
  "apps/web/src/settings/settings-ai-pane.tsx",
  "apps/web/src/settings/settings-appearance-pane.tsx",
  "apps/web/src/settings/settings-audit-pane.tsx",
  "apps/web/src/settings/settings-feedback.tsx",
  "apps/web/src/settings/settings-google-connect.tsx",
  "apps/web/src/settings/settings-imap-connect.tsx",
  "apps/web/src/settings/settings-memory-dashboard.tsx",
  "apps/web/src/settings/settings-module-registry-section.tsx",
  "apps/web/src/settings/settings-module-subviews.tsx",
  "apps/web/src/settings/settings-people-pane.tsx",
  "apps/web/src/settings/settings-personal-data-panes.tsx",
  "apps/web/src/settings/settings-personal-panes.tsx",
  "apps/web/src/settings/settings-profile-subviews.tsx",
  "apps/web/src/settings/settings-provider-login-dialog.tsx",
  "apps/web/src/settings/settings-skills-pane.tsx",
  "apps/web/src/settings/settings-ui.tsx",
  "apps/web/src/settings/settings-vault-chooser.tsx",
  "apps/web/src/settings/settings-voice-config-group.tsx",
  "apps/web/src/settings/settings-web-search-key-group.tsx",
  "apps/web/src/settings/settings-yolo-admin-group.tsx",
  "apps/web/src/settings/terminal-modal.tsx"
];

// D6 #1392: per-instance runtime chart geometry stays inline (same treatment as the calendar
// EventBlock ruling). Exempt from the inline-style check ONLY — guard 5 (raw jds-* classes) still
// covers these files via MIGRATED_SECTION_PATHS above.
const INLINE_STYLE_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "apps/web/src/wellness/radial-dial.tsx",
  "apps/web/src/wellness/wellness-chart.tsx"
]);

// Explicit class-family -> component name map. Resolving this by string munging (stripping
// "jds-" and title-casing) would make a silent mismatch pass the guard on everything — e.g. if
// jds-iconbtn were guessed as "Iconbtn" instead of looked up as "IconButton", the guard would
// never flag a hand-typed jds-iconbtn string. Every entry here was confirmed against the class
// each component's own source actually renders (packages/ui/src/*.tsx).
const CLASS_FAMILY_TO_COMPONENT: Readonly<Record<string, string>> = {
  "jds-agenda-row": "AgendaRow",
  "jds-avatar": "Avatar",
  "jds-badge": "Badge",
  "jds-btn": "Button",
  "jds-card": "Card",
  "jds-chip": "Chip",
  "jds-dialog": "Dialog",
  "jds-divider": "Divider",
  "jds-empty": "EmptyState",
  "jds-field": "Field",
  "jds-iconbtn": "IconButton",
  "jds-indicator": "Indicator",
  "jds-label": "FormLabel",
  "jds-masthead": "Masthead",
  "jds-menu": "Menu",
  "jds-segmented": "Segmented",
  "jds-select": "Select",
  "jds-selectwrap": "Select",
  "jds-stat-tile": "StatTile",
  "jds-switch": "Switch",
  "jds-weather-chip": "WeatherChip"
};

// Reduces a BEM-style token to its block name: `jds-badge--forest` and `jds-dialog__head` both
// become their leading family. Purely structural (finds the first `--`/`__`) — it does not decide
// which component owns the family, that lookup happens against CLASS_FAMILY_TO_COMPONENT below.
function classFamily(token: string): string {
  const separatorIndex = Math.min(
    ...["--", "__"]
      .map((sep) => token.indexOf(sep))
      .filter((index) => index !== -1)
      .concat([token.length])
  );
  return token.slice(0, separatorIndex);
}

// Reads the real, fixed index.ts export list (not the per-call `root` param, which in unit tests
// points at an isolated fixture directory with no packages/ui of its own) so the guard always
// checks against what @moss/ui actually exports today.
async function collectExportedComponentNames(): Promise<Set<string>> {
  const contents = await readFile(join(rootDirectory, "packages/ui/src/index.ts"), "utf8");
  const names = new Set<string>();

  for (const line of contents.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("export {")) continue;
    const inner = trimmed.slice(trimmed.indexOf("{") + 1, trimmed.indexOf("}"));
    for (const rawName of inner.split(",")) {
      const name = rawName.trim();
      if (name) names.add(name);
    }
  }

  return names;
}

export interface RawClassViolation {
  readonly path: string;
  readonly line: number;
  readonly className: string;
  readonly text: string;
}

export interface InlineStylePropertyViolation {
  readonly path: string;
  readonly line: number;
  readonly property: string;
  readonly text: string;
}

function kebabToCamel(property: string): string {
  return property.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

const BANNED_INLINE_STYLE_PROPERTIES = new Set(BANNED_VISUAL_PROPERTIES.map(kebabToCamel));

export async function checkRawClasses(
  root: string,
  migratedPaths: readonly string[] = MIGRATED_SECTION_PATHS
): Promise<RawClassViolation[]> {
  const violations: RawClassViolation[] = [];
  const tokenPattern = /\bjds-[a-zA-Z0-9-]+/g;
  const exportedComponents = await collectExportedComponentNames();

  for (const relativeFile of migratedPaths) {
    const contents = await readFileSafe(join(root, relativeFile));
    if (contents === undefined) continue;
    const lines = stripJsComments(contents).split(/\r\n|\r|\n/);
    const originalLines = contents.split(/\r\n|\r|\n/);

    lines.forEach((line, index) => {
      tokenPattern.lastIndex = 0;
      let match;
      while ((match = tokenPattern.exec(line)) !== null) {
        const family = classFamily(match[0]);
        const component = CLASS_FAMILY_TO_COMPONENT[family];
        if (component === undefined || !exportedComponents.has(component)) continue;

        violations.push({
          path: normalizePath(relativeFile),
          line: index + 1,
          className: match[0],
          text: originalLines[index]?.trim() ?? ""
        });
      }
    });
  }

  return violations;
}

export async function checkInlineStyleProperties(
  root: string,
  migratedPaths: readonly string[] = MIGRATED_SECTION_PATHS
): Promise<InlineStylePropertyViolation[]> {
  const violations: InlineStylePropertyViolation[] = [];

  for (const relativeFile of migratedPaths) {
    if (INLINE_STYLE_EXEMPT_PATHS.has(normalizePath(relativeFile))) continue;
    const contents = await readFileSafe(join(root, relativeFile));
    if (contents === undefined) continue;
    const stripped = stripJsComments(contents);

    for (const styleBlock of extractStyleObjects(stripped)) {
      const keyPattern = /([a-zA-Z]+)\s*:/g;
      let match;
      while ((match = keyPattern.exec(styleBlock.content)) !== null) {
        const property = match[1];
        if (property && BANNED_INLINE_STYLE_PROPERTIES.has(property)) {
          const line = lineOf(stripped, styleBlock, match.index);
          const originalLines = contents.split(/\r\n|\r|\n/);
          violations.push({
            path: normalizePath(relativeFile),
            line,
            property,
            text: originalLines[line - 1]?.trim() ?? ""
          });
        }
      }
    }
  }

  return violations;
}

// Finds each `style={{...}}` occurrence and returns the balanced-brace inner content. Not a full
// JS parser — adequate for a guard scoped to a small, manually curated migrated-file list.
function extractStyleObjects(source: string): Array<{ content: string; offset: number }> {
  const blocks: Array<{ content: string; offset: number }> = [];
  const marker = "style={{";
  let searchFrom = 0;

  while (true) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) break;
    const contentStart = start + marker.length - 1; // keep one opening brace for balance counting
    let depth = 0;
    let end = -1;
    for (let i = contentStart; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) break;
    blocks.push({ content: source.slice(contentStart + 1, end), offset: contentStart + 1 });
    searchFrom = end + 1;
  }

  return blocks;
}

function lineOf(fullSource: string, block: { offset: number }, indexInBlock: number): number {
  const absoluteIndex = block.offset + indexInBlock;
  return fullSource.slice(0, absoluteIndex).split(/\r\n|\r|\n/).length;
}

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

function stripJsComments(contents: string): string {
  return contents
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, " "))
    .replace(/\/\/[^\r\n]*/g, (comment) => comment.replace(/[^\r\n]/g, " "));
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function selfTest(): void {
  const tokenPattern = /\bjds-[a-zA-Z0-9-]+/g;
  if (!tokenPattern.test('className="jds-btn"')) {
    console.error("Self-test failed: raw-class guard did not catch jds-btn");
    process.exit(1);
  }

  const blocks = extractStyleObjects('<div style={{ color: "red", display: "flex" }} />');
  if (blocks.length !== 1 || !blocks[0]!.content.includes("color")) {
    console.error("Self-test failed: inline-style extraction did not find the style object");
    process.exit(1);
  }
  if (
    !BANNED_INLINE_STYLE_PROPERTIES.has("color") ||
    BANNED_INLINE_STYLE_PROPERTIES.has("display")
  ) {
    console.error("Self-test failed: inline-style banned-property set is wrong (color/display)");
    process.exit(1);
  }

  for (const exemptPath of INLINE_STYLE_EXEMPT_PATHS) {
    if (!MIGRATED_SECTION_PATHS.includes(exemptPath)) {
      console.error(
        `Self-test failed: INLINE_STYLE_EXEMPT_PATHS entry ${exemptPath} is missing from ` +
          "MIGRATED_SECTION_PATHS — the exemption must skip only the inline-style check, not " +
          "raw-class (guard 5) coverage"
      );
      process.exit(1);
    }
  }
}

async function main(): Promise<void> {
  selfTest();

  const [rawClassViolations, inlineStyleViolations] = await Promise.all([
    checkRawClasses(rootDirectory),
    checkInlineStyleProperties(rootDirectory)
  ]);

  if (rawClassViolations.length === 0 && inlineStyleViolations.length === 0) {
    console.log("No migrated-section violations found.");
    return;
  }

  if (rawClassViolations.length > 0) {
    console.error(
      "Raw jds-* class in a migrated section (use the @moss/ui component instead of a hand-typed class):"
    );
    for (const violation of rawClassViolations) {
      console.error(
        `- ${violation.path}:${violation.line} ${violation.className} — ${violation.text}`
      );
    }
  }

  if (inlineStyleViolations.length > 0) {
    console.error(
      "Banned visual property in a migrated section's inline style (D2: layout only; colour/type/border/radius/shadow come from a component or token):"
    );
    for (const violation of inlineStyleViolations) {
      console.error(
        `- ${violation.path}:${violation.line} ${violation.property} — ${violation.text}`
      );
    }
  }

  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
