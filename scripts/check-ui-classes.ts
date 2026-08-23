import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guard 1: every literal `jds-*` class used in TSX must be defined by a CSS file in the pinned
 * scope. Guard 2: `jds-*` names built by suffix interpolation (`` `jds-foo--${x}` ``) are invisible
 * to a literal scan, so they're tracked separately against an explicit burn-down list rather than
 * silently passing.
 *
 * Definition scope is pinned to packages/ui's styles + apps/web/src/styles/ — NOT
 * `Jarvis Design System/` (gitignored, and D4 makes it *generated from* packages/ui, so it would be
 * circular as a definition source) and NOT `.claude/worktrees/` (sibling worktree checkouts would
 * make the guard's answer depend on which agents happen to have a worktree open). Usage scope is
 * explicitly enumerated top-level roots for the same reason: a recursive walk from repo root would
 * wander into both of those.
 */

const rootDirectory = process.cwd();

export const WEB_DEFINITION_FILES = [
  "apps/web/src/styles/command-palette.css",
  "apps/web/src/styles/components-forms.css",
  "apps/web/src/styles/components-keyline.css",
  "apps/web/src/styles/index.css",
  "apps/web/src/styles/kit-calendar.css",
  "apps/web/src/styles/kit-chat-attach.css",
  "apps/web/src/styles/kit-chat.css",
  "apps/web/src/styles/kit-chat-skills.css",
  "apps/web/src/styles/kit-tasks.css",
  "apps/web/src/styles/kit-tasks-modal.css",
  "apps/web/src/styles/kit-today.css",
  "apps/web/src/styles/kit-today-feeds.css",
  "apps/web/src/styles/kit-today-misc.css",
  "apps/web/src/styles/onboarding-connectors.css",
  "apps/web/src/styles/onboarding.css",
  "apps/web/src/styles/onboarding-design.css",
  "apps/web/src/styles/settings.css",
  "apps/web/src/styles/settings-panes-2.css",
  "apps/web/src/styles/settings-panes-3.css",
  "apps/web/src/styles/settings-panes.css",
  "apps/web/src/styles/texture.css",
  "apps/web/src/styles/tokens.css",
  "apps/web/src/styles/wellness-1.css",
  "apps/web/src/styles/wellness-2.css",
  "apps/web/src/styles/wellness-3.css"
];

const PACKAGE_STYLE_ROOT = "packages/ui/src/styles";

const USAGE_ROOTS = ["apps/web/src", "packages", "external-modules"];

const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".git", "build", "coverage"]);

/**
 * Sites where a `jds-*` class name is built by suffix interpolation (`` `jds-foo--${x}` ``).
 * A literal scan can't see the resulting class name, so guard 1 can't validate these — they're
 * deliberately carved out here rather than silently passing. Each entry is a burn-down candidate:
 * remove it once the site is converted to a typed variant mapping (the `packages/ui` pattern) or
 * an exhaustive switch. New interpolation sites outside `packages/ui` must be added here or the
 * guard fails — this is what stops the list from growing invisibly.
 */
const KNOWN_INTERPOLATION_SITES = new Set([
  "apps/web/src/tasks/task-list-view.tsx",
  "apps/web/src/settings/settings-feedback.tsx",
  "apps/web/src/today/brief-task-row.tsx",
  "apps/web/src/today/today-page.tsx",
  "apps/web/src/chat/assistant-surface/surface.tsx",
  "packages/settings-ui/src/index.tsx",
  "external-modules/job-search/src/web/root.tsx",
  "external-modules/job-search/src/web/screens/onboarding.tsx",
  "external-modules/job-search/src/web/screens/settings.tsx",
  "external-modules/job-search/src/web/screens/overview.tsx"
]);

export interface ClassViolation {
  readonly path: string;
  readonly line: number;
  readonly className: string;
  readonly text: string;
}

export interface InterpolationViolation {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface CheckResult {
  readonly definedClasses: ReadonlySet<string>;
  readonly undefinedClassViolations: ClassViolation[];
  readonly unlistedInterpolationViolations: InterpolationViolation[];
}

export async function collectDefinedClasses(root: string): Promise<Set<string>> {
  const defined = new Set<string>();
  const classSelectorPattern = /\.(jds-[a-zA-Z0-9-]+)/g;
  const packageDefinitionFiles: string[] = [];

  for await (const filePath of walk(join(root, PACKAGE_STYLE_ROOT))) {
    if (extname(filePath) === ".css") {
      packageDefinitionFiles.push(normalizePath(relative(root, filePath)));
    }
  }

  for (const relativeFile of [...packageDefinitionFiles.sort(), ...WEB_DEFINITION_FILES]) {
    const contents = await readFile(join(root, relativeFile), "utf8");
    const stripped = stripCssComments(contents);
    let match;
    classSelectorPattern.lastIndex = 0;
    while ((match = classSelectorPattern.exec(stripped)) !== null) {
      if (match[1]) defined.add(match[1]);
    }
  }

  return defined;
}

export async function checkUiClasses(root: string): Promise<CheckResult> {
  const definedClasses = await collectDefinedClasses(root);
  const undefinedClassViolations: ClassViolation[] = [];
  const unlistedInterpolationViolations: InterpolationViolation[] = [];

  for (const usageRoot of USAGE_ROOTS) {
    for await (const filePath of walk(join(root, usageRoot))) {
      if (extname(filePath) !== ".tsx") continue;

      const relativePath = normalizePath(relative(root, filePath));
      const contents = await readFile(filePath, "utf8");
      const stripped = stripJsComments(contents);
      const lines = stripped.split(/\r\n|\r|\n/);
      const originalLines = contents.split(/\r\n|\r|\n/);

      const isPackageUiFile = relativePath.startsWith("packages/ui/");

      lines.forEach((line, index) => {
        const tokenPattern = /\bjds-[a-zA-Z0-9-]+/g;
        let tokenMatch;
        while ((tokenMatch = tokenPattern.exec(line)) !== null) {
          const token = tokenMatch[0];
          const endIndex = tokenMatch.index + token.length;
          // A genuine suffix-interpolation site builds a class by appending a dynamic value onto
          // a trailing hyphen (`jds-foo--${x}`) — the token isn't a complete class on its own.
          // `jds-btn--sm${cond ? " jds-btn--active" : ""}` is NOT this: "jds-btn--sm" is already
          // complete, and the interpolation appends a wholly separate token afterward.
          const isInterpolationPrefix =
            token.endsWith("-") && line.slice(endIndex, endIndex + 2) === "${";

          if (isInterpolationPrefix) {
            if (isPackageUiFile) continue; // spec: typed variant mappings inside packages/ui are exempt
            if (!KNOWN_INTERPOLATION_SITES.has(relativePath)) {
              unlistedInterpolationViolations.push({
                path: relativePath,
                line: index + 1,
                text: originalLines[index]?.trim() ?? ""
              });
            }
            continue;
          }

          if (!definedClasses.has(token)) {
            undefinedClassViolations.push({
              path: relativePath,
              line: index + 1,
              className: token,
              text: originalLines[index]?.trim() ?? ""
            });
          }
        }
      });
    }
  }

  return { definedClasses, undefinedClassViolations, unlistedInterpolationViolations };
}

async function* walk(directory: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
      yield* walk(join(directory, entry.name));
      continue;
    }
    if (entry.isFile()) {
      yield join(directory, entry.name);
    }
  }
}

function stripCssComments(contents: string): string {
  return contents.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, " "));
}

function stripJsComments(contents: string): string {
  return contents
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\r\n]/g, " "))
    .replace(/\/\/[^\r\n]*/g, (comment) => comment.replace(/[^\r\n]/g, " "));
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

async function selfTest(): Promise<void> {
  const defined = new Set(["jds-btn"]);
  const testLine = 'className="jds-btn jds-intentionally-undefined-test-class"';
  const tokenPattern = /\bjds-[a-zA-Z0-9-]+/g;
  let found = false;
  let match;
  while ((match = tokenPattern.exec(testLine)) !== null) {
    if (!defined.has(match[0])) found = true;
  }
  if (!found) {
    console.error("Self-test failed: guard did not catch jds-intentionally-undefined-test-class");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await selfTest();

  const { undefinedClassViolations, unlistedInterpolationViolations } =
    await checkUiClasses(rootDirectory);

  if (undefinedClassViolations.length === 0 && unlistedInterpolationViolations.length === 0) {
    console.log("No UI class violations found.");
    return;
  }

  if (undefinedClassViolations.length > 0) {
    console.error(
      "Undefined jds-* class usage (not defined in packages/ui or apps/web/src/styles):"
    );
    for (const violation of undefinedClassViolations) {
      console.error(
        `- ${violation.path}:${violation.line} ${violation.className} — ${violation.text}`
      );
    }
  }

  if (unlistedInterpolationViolations.length > 0) {
    console.error(
      "jds-* suffix interpolation outside packages/ui, not in KNOWN_INTERPOLATION_SITES:"
    );
    for (const violation of unlistedInterpolationViolations) {
      console.error(`- ${violation.path}:${violation.line} ${violation.text}`);
    }
    console.error(
      "Add the file to KNOWN_INTERPOLATION_SITES in scripts/check-ui-classes.ts (burn-down list) " +
        "or convert the site to a typed variant mapping."
    );
  }

  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
