import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pre-epic guard: CSS color literals must live only in tokens.css, and every `var(--...)` usage
 * must resolve to a token actually defined there.
 *
 * Guard 4 (#1388 Foundation, D2): "A screen's own CSS may do layout only — position, spacing,
 * grid, flex. Colour, type, border, radius and shadow come from a component or a token." Once a
 * section migrates (its markup converted to @moss/ui components, its CSS reduced to layout),
 * its CSS files are added to MIGRATED_SECTION_CSS_FILES and this guard starts rejecting any of
 * BANNED_VISUAL_PROPERTIES declared there. The list starts empty: Foundation converts no screens
 * (spec "Section 1 — Foundation... No screen changes"), so this guard must not red the tree on day
 * one. Each section's own task issue (calendar first per D7) owns adding its files here.
 */

const rootDirectory = process.cwd();
const allowedColorLiteralFile = "apps/web/src/styles/tokens.css";
const colorLiteralPattern = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g;
const stockIndigoPattern = /#(?:4f46e5|6366f1|4338ca|3730a3|818cf8|c7d2fe)\b/i;
const varUsagePattern = /var\(\s*(--[a-zA-Z0-9-]+)/g;

// Tokens that are injected at runtime or scoped to specific components
const allowList = new Set([
  "--ev", // Calendar event color injection
  "--cal-h",
  "--em-tint",
  "--em-soft",
  "--em-ink",
  // job-search's Score component (score.tsx) sets this as a 0-1 fraction inline — a caller-scoped
  // runtime value, not a design token. Want still renders through the jds-score bar everywhere Fit
  // doesn't (K-D1 covers Fit only), so this survives the Matches board rebuild.
  "--jds-score",
  // #1393 Tasks: avatar background color, hashed per-name in Ava (task-details-sections.tsx).
  // Consuming var() lives in packages/ui/src/styles/components-tasks.css, outside this guard's
  // apps/web/src scan root, so this entry documents intent rather than unblocking a violation.
  "--tk-ava-bg",
  // #1393 Tasks: avatar font-size, scaled from the size prop in Ava. Same components-tasks.css
  // consumer, same out-of-scan-root note as --tk-ava-bg above.
  "--tk-ava-fs",
  // #1393 Tasks: shared per-instance swatch color for priority dots/bars (priorityColor()) and
  // list dots (listColorMap()) in task-list-view.tsx. Same components-tasks.css consumer, same
  // out-of-scan-root note as --tk-ava-bg above.
  "--tk-swatch",
  // #1395 Settings: runtime accent-ramp / staged-palette swatch color in settings-appearance-pane.
  // Consuming var() is in apps/web/src/styles/settings-panes-3.css today; Task 4's CSS split moves
  // it to packages/ui/src/styles/components-settings-*.css, same out-of-scan-root shape as
  // --tk-swatch. Named --st-swatch (not --swatch) per the coordinator's ruling — every sectional
  // runtime token here is scoped, and a bare name would be the one an ancestor could capture.
  "--st-swatch"
]);

export interface TokenViolation {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface BannedPropertyViolation {
  readonly path: string;
  readonly line: number;
  readonly property: string;
  readonly text: string;
}

// The four cases singled out by the spec because they're otherwise argued every review:
// background-image gradients, outline, fill/stroke, filter: drop-shadow. Banned as whole
// properties, same as the others, for a guard that's a regex scan rather than a CSS parser.
export const BANNED_VISUAL_PROPERTIES = [
  "color",
  "background",
  "background-color",
  "background-image",
  "border",
  "border-color",
  "border-radius",
  "font-family",
  "font-size",
  "font-weight",
  "box-shadow",
  "outline",
  "fill",
  "stroke",
  "filter"
] as const;

// Burn-down list, owned by each section's own migration task — starts empty for Foundation.
export const MIGRATED_SECTION_CSS_FILES: readonly string[] = [
  "apps/web/src/styles/kit-calendar.css",
  "apps/web/src/styles/kit-chat.css",
  "apps/web/src/styles/kit-chat-attach.css",
  "apps/web/src/styles/kit-chat-skills.css",
  "apps/web/src/chat/chat-model-pill.css",
  "apps/web/src/styles/onboarding.css",
  "apps/web/src/styles/onboarding-connectors.css",
  "apps/web/src/styles/onboarding-design.css",
  "apps/web/src/styles/wellness-1.css",
  "apps/web/src/styles/wellness-2.css",
  "apps/web/src/styles/wellness-3.css",
  "apps/web/src/styles/kit-tasks.css",
  "apps/web/src/styles/kit-tasks-modal.css",
  "apps/web/src/tasks/tasks.css",
  // #1394 Shipped modules: news + sports. These live under packages/, outside checkTokens'
  // apps/web/src walk root, but checkBannedProperties resolves each entry against the repo root
  // directly, so the layout-only rule is enforced here just as it is for apps/web sections.
  "packages/news/src/settings/news-settings.css",
  "packages/news/src/web/styles/news-1.css",
  "packages/news/src/web/styles/news-2.css",
  "packages/sports/src/settings/sports-2.css",
  "packages/sports/src/web/styles/sports-1.css",
  "packages/sports/src/web/styles/sports-3.css",
  "packages/sports/src/web/styles/sports-4-grid.css",
  "packages/sports/src/web/styles/sports-5-editorial.css",
  "packages/sports/src/web/styles/sports-6-newsband.css",
  // #1395 Settings: Task 4's layout/visual split reduced these four to layout-only; the visual
  // half moved to packages/ui/src/styles/components-settings-1.css and components-settings-2.css
  // (component CSS, not screen CSS — deliberately NOT added here, since D2 only bans visual
  // properties in a screen's own CSS).
  "apps/web/src/styles/settings.css",
  "apps/web/src/styles/settings-panes.css",
  "apps/web/src/styles/settings-panes-2.css",
  "apps/web/src/styles/settings-panes-3.css",
  // #1427-B: command palette, moved to packages/ui/src/styles/components-command-palette.css.
  "apps/web/src/styles/command-palette.css",
  // #1427-C: assistant surface, moved to packages/ui/src/styles/components-chat.css.
  "apps/web/src/chat/assistant-surface/assistant-surface.css",
  // #1427-D: web forms, moved to packages/ui/src/styles/components-forms.css.
  "apps/web/src/styles/components-forms.css",
  // #1427-E: keyline primitives + global texture, moved to packages/ui/src/styles/components-keyline.css and components-web.css.
  "apps/web/src/styles/components-keyline.css",
  "apps/web/src/styles/texture.css"
];

let validTokensCache: Set<string> | undefined;

async function loadValidTokens(root: string): Promise<Set<string>> {
  if (validTokensCache) return validTokensCache;
  const tokensFile = await readFile(join(root, allowedColorLiteralFile), "utf8");
  const validTokens = new Set<string>();
  const tokenDefPattern = /^\s*(--[a-zA-Z0-9-]+)\s*:/gm;
  let match;
  while ((match = tokenDefPattern.exec(tokensFile)) !== null) {
    if (match[1]) validTokens.add(match[1]);
  }
  validTokensCache = validTokens;
  return validTokens;
}

export async function checkTokens(root: string): Promise<TokenViolation[]> {
  const validTokens = await loadValidTokens(root);
  const violations: TokenViolation[] = [];

  for await (const filePath of walk(join(root, "apps/web/src"))) {
    const ext = extname(filePath);
    if (ext !== ".css" && ext !== ".ts" && ext !== ".tsx") continue;

    const relativePath = normalizePath(relative(root, filePath));
    const contents = await readFile(filePath, "utf8");
    const searchable = stripCssComments(contents);
    const lines = searchable.split(/\r\n|\r|\n/);
    const originalLines = contents.split(/\r\n|\r|\n/);

    lines.forEach((line, index) => {
      if (ext === ".css") {
        const hasForbiddenColorLiteral =
          relativePath !== allowedColorLiteralFile && colorLiteralPattern.test(line);
        colorLiteralPattern.lastIndex = 0;

        if (hasForbiddenColorLiteral || stockIndigoPattern.test(line)) {
          violations.push({
            path: relativePath,
            line: index + 1,
            text: `Forbidden literal: ${originalLines[index]?.trim() ?? ""}`
          });
        }
      }

      varUsagePattern.lastIndex = 0;
      let varMatch;
      while ((varMatch = varUsagePattern.exec(line)) !== null) {
        const tokenName = varMatch[1];
        if (tokenName && !validTokens.has(tokenName) && !allowList.has(tokenName)) {
          violations.push({
            path: relativePath,
            line: index + 1,
            text: `Undefined token ${tokenName}: ${originalLines[index]?.trim() ?? ""}`
          });
        }
      }
    });
  }

  return violations;
}

export async function checkBannedProperties(
  root: string,
  migratedFiles: readonly string[] = MIGRATED_SECTION_CSS_FILES
): Promise<BannedPropertyViolation[]> {
  const bannedSet = new Set<string>(BANNED_VISUAL_PROPERTIES);
  // Not anchored to line-start: a declaration can follow a selector's `{` on the same line.
  // Anchored instead to a declaration boundary (`{`, `;`, or line-start).
  const propertyPattern = /(?:^|[{;])\s*([a-zA-Z-]+)\s*:/g;
  const violations: BannedPropertyViolation[] = [];

  for (const relativeFile of migratedFiles) {
    let contents: string;
    try {
      contents = await readFile(join(root, relativeFile), "utf8");
    } catch {
      continue;
    }
    const stripped = stripCssComments(contents);
    const lines = stripped.split(/\r\n|\r|\n/);
    const originalLines = contents.split(/\r\n|\r|\n/);

    lines.forEach((line, index) => {
      propertyPattern.lastIndex = 0;
      let declMatch;
      while ((declMatch = propertyPattern.exec(line)) !== null) {
        const property = declMatch[1]?.toLowerCase();
        if (property && bannedSet.has(property)) {
          violations.push({
            path: normalizePath(relativeFile),
            line: index + 1,
            property,
            text: originalLines[index]?.trim() ?? ""
          });
        }
      }
    });
  }

  return violations;
}

async function* walk(directory: string): AsyncGenerator<string> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      yield* walk(entryPath);
      continue;
    }

    if (entry.isFile()) {
      yield entryPath;
    }
  }
}

function stripCssComments(contents: string): string {
  return contents.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, " "));
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function selfTest(): void {
  const mockLine = "color: var(--intentionally-undefined-test-var);";
  varUsagePattern.lastIndex = 0;
  const testMatch = varUsagePattern.exec(mockLine);
  if (!testMatch || !testMatch[1] || allowList.has(testMatch[1])) {
    console.error("Self-test failed: token guard did not catch --intentionally-undefined-test-var");
    process.exit(1);
  }

  const bannedSet = new Set<string>(BANNED_VISUAL_PROPERTIES);
  const declMatch = /^\s*([a-zA-Z-]+)\s*:/.exec("  background-color: #fff;");
  if (!declMatch?.[1] || !bannedSet.has(declMatch[1].toLowerCase())) {
    console.error("Self-test failed: banned-property guard did not catch background-color");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  selfTest();

  const [tokenViolations, bannedPropertyViolations] = await Promise.all([
    checkTokens(rootDirectory),
    checkBannedProperties(rootDirectory)
  ]);

  if (tokenViolations.length === 0 && bannedPropertyViolations.length === 0) {
    console.log("No design-token violations found.");
    return;
  }

  if (tokenViolations.length > 0) {
    console.error("Design-token violations:");
    console.error(`- CSS color literals must live in ${allowedColorLiteralFile}.`);
    console.error("- Stock-indigo literals are not part of the Jarv1s palette.");
    console.error("- All var(--...) tokens must be defined in tokens.css.");
    for (const violation of tokenViolations) {
      console.error(`- ${violation.path}:${violation.line} ${violation.text}`);
    }
  }

  if (bannedPropertyViolations.length > 0) {
    console.error(
      "Banned visual property in a migrated section's CSS (D2: screen CSS is layout only):"
    );
    for (const violation of bannedPropertyViolations) {
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
