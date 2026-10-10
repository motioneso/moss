import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
  "apps/web/src/styles/kit-briefing-reader.css",
  "apps/web/src/styles/kit-day-plan-review.css",
  "apps/web/src/styles/kit-evening-planning.css",
  "apps/web/src/styles/kit-calendar.css",
  "apps/web/src/styles/kit-chat-attach.css",
  "apps/web/src/styles/kit-chat.css",
  "apps/web/src/styles/kit-chat-skills.css",
  "apps/web/src/styles/kit-tasks.css",
  "apps/web/src/styles/kit-tasks-modal.css",
  "apps/web/src/styles/kit-today.css",
  "apps/web/src/styles/kit-today-desks.css",
  "apps/web/src/styles/kit-today-feeds.css",
  "apps/web/src/styles/kit-today-misc.css",
  "apps/web/src/styles/kit-today-timeline.css",
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
  readonly moduleLocalClassViolations: ModuleLocalClassViolation[];
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

  const moduleLocalClassViolations = await checkModuleLocalClasses(root);
  return {
    definedClasses,
    undefinedClassViolations,
    unlistedInterpolationViolations,
    moduleLocalClassViolations
  };
}

/** Audited first-party modules only; held replacement modules are not enrolled here. */
export const MODULE_LOCAL_ROOTS = [
  "packages/news/src",
  "packages/sports/src",
  "packages/workshop/src",
  "packages/backtrack/src",
  "packages/meetings/src",
  "external-modules/finance/src"
] as const;

interface StructuralHook {
  readonly path: string;
  readonly className: string;
  readonly reason: string;
}
interface DynamicClassValues {
  readonly path: string;
  readonly expression: string;
  readonly values: readonly string[];
  readonly reason: string;
}
interface LocalClassOptions {
  readonly structuralHooks?: readonly StructuralHook[];
  readonly dynamicValues?: readonly DynamicClassValues[];
}
export interface ModuleLocalClassViolation extends ClassViolation {
  readonly kind: "undefined-class" | "unresolved-expression";
}

// Exceptions identify one intentional nonvisual hook, never a whole file or prefix.
const STRUCTURAL_MODULE_HOOKS: readonly StructuralHook[] = [
  {
    path: "packages/news/src/web/today-widget.tsx",
    className: "nw-twnote__eyebrow",
    reason: "Today context-note UAT locator verifies heading content and shared Eyebrow weight."
  },
  {
    path: "packages/sports/src/web/sports-news.tsx",
    className: "sp-latest",
    reason: "Sports page regression locator for the labeled Top stories section."
  },
  {
    path: "packages/sports/src/web/sports-ticker.tsx",
    className: "sp-tk__next--live",
    reason: "Live-status regression locator distinguishes live and upcoming footer content."
  },
  {
    path: "packages/sports/src/web/sports-ticker.tsx",
    className: "sp-tk--league",
    reason: "League-versus-team cardinality regression locator; no distinct visual skin."
  },
  {
    path: "packages/sports/src/web/sports-page.tsx",
    className: "sp-scorebar__clock",
    reason: "Dedicated game-clock formatting regression locator; inherits its text role."
  }
];
const DYNAMIC_MODULE_CLASSES: readonly DynamicClassValues[] = [
  {
    path: "packages/news/src/web/lead-art.tsx",
    expression: "leadArtPalette(topic)",
    values: ["climate", "world", "culture", "technology"],
    reason: "LeadArtPalette's four categories; each resulting modifier must have a real selector."
  },
  {
    path: "packages/sports/src/web/sports-parts.tsx",
    expression: "props.size",
    values: ["sm", "md", "lg"],
    reason: "Crest's public size union; each resulting modifier must have a real selector."
  },
  {
    path: "packages/sports/src/web/sports-parts.tsx",
    expression: "result.toLowerCase()",
    values: ["w", "d", "l"],
    reason: "FormPip result union W/D/L maps to the three stable non-danger outcomes."
  },
  {
    path: "packages/sports/src/web/sports-standings.tsx",
    expression: "edge",
    values: ["away", "home"],
    reason: "KnockTeam edge union selects the two bracket positions."
  },
  {
    path: "packages/sports/src/web/sports-around-ticker.tsx",
    expression: "props.className",
    values: ["sp-around__logo"],
    reason: "Private Mark helper has exactly two local calls, both league-logo images."
  },
  {
    path: "packages/meetings/src/web/meeting-record.tsx",
    expression: 'buttonLinkClassName("link")',
    values: ["jds-btn jds-btn--link"],
    reason: "Canonical @moss/ui ButtonLink helper for a router link; public class guard owns jds."
  },
  {
    path: "packages/meetings/src/web/meetings-page.tsx",
    expression: 'buttonLinkClassName("link")',
    values: ["jds-btn jds-btn--link"],
    reason: "Canonical @moss/ui ButtonLink helper for a router link; public class guard owns jds."
  }
];

function localCssClasses(contents: string): Set<string> {
  // Only selector text counts. Comments and quoted strings cannot bless a hook.
  const css = stripCssComments(contents).replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
  const result = new Set<string>();
  for (const block of css.matchAll(/([^{}]+)\{/g)) {
    if (block[1]!.trim().startsWith("@")) continue;
    for (const match of block[1]!.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)) {
      result.add(match[1]!);
    }
  }
  return result;
}

function nearestScope(node: ts.Node): ts.Block | ts.SourceFile {
  let current: ts.Node = node;
  while (!ts.isBlock(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}
function findLocalBinding(node: ts.Identifier): ts.VariableDeclaration | undefined {
  let scope: ts.Node | undefined = nearestScope(node);
  while (scope) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === node.text) {
            return declaration;
          }
        }
      }
    }
    scope = scope.parent;
  }
  return undefined;
}

/** Static finite class values only; unknown expressions fail rather than silently disappear. */
function moduleClassValues(
  expression: ts.Expression,
  source: ts.SourceFile,
  path: string,
  contracts: readonly DynamicClassValues[],
  unknown: Set<ts.Node>,
  visiting = new Set<ts.Node>()
): string[] {
  const contract = contracts.find(
    (entry) => entry.path === path && entry.expression === expression.getText(source)
  );
  if (contract?.reason.trim() && contract.values.length) return [...contract.values];
  const values = (node: ts.Expression) =>
    moduleClassValues(node, source, path, contracts, unknown, visiting);
  const product = (left: string[], right: string[], separator = "") => {
    if (left.length * right.length > 256) {
      unknown.add(expression);
      return [];
    }
    return [...new Set(left.flatMap((a) => right.map((b) => `${a}${separator}${b}`)))];
  };
  if (visiting.has(expression)) {
    unknown.add(expression);
    return [];
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return [expression.text];
  }
  if (
    expression.kind === ts.SyntaxKind.NullKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(expression) && expression.text === "undefined")
  )
    return [""];
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    return values(expression.expression);
  if (ts.isConditionalExpression(expression)) {
    return [...new Set([...values(expression.whenTrue), ...values(expression.whenFalse)])];
  }
  if (ts.isBinaryExpression(expression)) {
    if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return product(values(expression.left), values(expression.right));
    }
    if (expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return ["", ...values(expression.right)];
    }
    if (
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
        expression.operatorToken.kind
      )
    ) {
      return [...new Set([...values(expression.left), ...values(expression.right)])];
    }
  }
  if (ts.isTemplateExpression(expression)) {
    let result = [expression.head.text];
    for (const span of expression.templateSpans) {
      result = product(result, values(span.expression)).map((value) => value + span.literal.text);
    }
    return result;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    let result = [""];
    for (const element of expression.elements) {
      if (ts.isSpreadElement(element)) {
        unknown.add(element);
        return [];
      }
      result = product(result, values(element), " ");
    }
    return result;
  }
  if (ts.isIdentifier(expression)) {
    const declaration = findLocalBinding(expression);
    if (declaration?.initializer) {
      visiting.add(expression);
      let result = values(declaration.initializer);
      // Only immutable values and explicit array pushes are supported. Do not silently
      // trust a valid initializer when later assignment or a mutating method changes it.
      const scope = nearestScope(declaration);
      const referencesBinding = (node: ts.Node): boolean =>
        ts.isIdentifier(node) && findLocalBinding(node) === declaration;
      const visit = (node: ts.Node) => {
        if (node !== scope && ts.isFunctionLike(node)) return;
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          (referencesBinding(node.left) ||
            (ts.isElementAccessExpression(node.left) && referencesBinding(node.left.expression)))
        ) {
          unknown.add(node);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          referencesBinding(node.expression.expression)
        ) {
          const method = node.expression.name.text;
          if (method === "push" && ts.isArrayLiteralExpression(declaration.initializer!)) {
            for (const argument of node.arguments) {
              result = product(result, ["", ...values(argument)], " ");
            }
          } else if (method !== "filter" && method !== "join") {
            unknown.add(node);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(scope);
      visiting.delete(expression);
      return result;
    }
  }
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)) {
    const method = expression.expression.name.text;
    if (
      method === "filter" &&
      expression.arguments.length === 1 &&
      expression.arguments[0]!.getText(source) === "Boolean"
    ) {
      return values(expression.expression.expression);
    }
    if (
      method === "join" &&
      expression.arguments.length === 1 &&
      ts.isStringLiteral(expression.arguments[0]!) &&
      expression.arguments[0]!.text === " "
    ) {
      return values(expression.expression.expression);
    }
  }
  unknown.add(expression);
  return [];
}

export async function checkModuleLocalClasses(
  root: string,
  options: LocalClassOptions = {}
): Promise<ModuleLocalClassViolation[]> {
  const shared = new Set<string>();
  for (const directory of ["packages/ui/src/styles", "apps/web/src/styles"]) {
    for await (const file of walk(join(root, directory))) {
      if (extname(file) === ".css") {
        for (const name of localCssClasses(await readFile(file, "utf8"))) shared.add(name);
      }
    }
  }
  try {
    for (const name of localCssClasses(
      await readFile(join(root, "apps/web/src/styles.css"), "utf8")
    ))
      shared.add(name);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const violations: ModuleLocalClassViolation[] = [];
  for (const moduleRoot of MODULE_LOCAL_ROOTS) {
    const files: string[] = [];
    const defined = new Set(shared);
    for await (const file of walk(join(root, moduleRoot))) {
      if (extname(file) === ".tsx") files.push(file);
      if (extname(file) === ".css") {
        for (const name of localCssClasses(await readFile(file, "utf8"))) defined.add(name);
      }
      // Finance ships a static stylesheet on its module contract rather than as a CSS asset.
      if (normalizePath(relative(root, file)) === "external-modules/finance/src/web/styles.ts") {
        const source = ts.createSourceFile(
          file,
          await readFile(file, "utf8"),
          ts.ScriptTarget.Latest,
          true
        );
        const visit = (node: ts.Node) => {
          if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "MODULE_STYLES" &&
            node.initializer &&
            ts.isNoSubstitutionTemplateLiteral(node.initializer)
          ) {
            for (const name of localCssClasses(node.initializer.text)) defined.add(name);
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
      }
    }
    for (const file of files) {
      const path = normalizePath(relative(root, file));
      const contents = await readFile(file, "utf8");
      const source = ts.createSourceFile(
        file,
        contents,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      );
      const unknown = new Set<ts.Node>();
      const reported = new Set<string>();
      const report = (
        node: ts.Node,
        className: string,
        kind: ModuleLocalClassViolation["kind"]
      ) => {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const key = `${line}:${className}:${kind}`;
        if (reported.has(key)) return;
        reported.add(key);
        violations.push({
          path,
          line,
          className,
          kind,
          text: contents.split(/\r?\n/)[line - 1]?.trim() ?? ""
        });
      };
      const visit = (node: ts.Node) => {
        if (
          ts.isJsxAttribute(node) &&
          node.name.getText(source) === "className" &&
          node.initializer
        ) {
          const expression = ts.isJsxExpression(node.initializer)
            ? node.initializer.expression
            : node.initializer;
          if (expression) {
            const values = moduleClassValues(
              expression,
              source,
              path,
              options.dynamicValues ?? DYNAMIC_MODULE_CLASSES,
              unknown
            );
            for (const name of new Set(
              values.flatMap((value) => value.split(/\s+/)).filter(Boolean)
            )) {
              if (name.startsWith("jds-") || defined.has(name)) continue; // Existing public jds guard owns that namespace.
              const excepted = (options.structuralHooks ?? STRUCTURAL_MODULE_HOOKS).some(
                (entry) => entry.path === path && entry.className === name && entry.reason.trim()
              );
              if (!excepted) report(node, name, "undefined-class");
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      for (const node of unknown) report(node, node.getText(source), "unresolved-expression");
    }
  }
  return violations;
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

  const { undefinedClassViolations, unlistedInterpolationViolations, moduleLocalClassViolations } =
    await checkUiClasses(rootDirectory);

  if (
    undefinedClassViolations.length === 0 &&
    unlistedInterpolationViolations.length === 0 &&
    moduleLocalClassViolations.length === 0
  ) {
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

  if (moduleLocalClassViolations.length > 0) {
    console.error("Module-local class contracts (audited modules; own/shared CSS only):");
    for (const violation of moduleLocalClassViolations) {
      console.error(
        `- ${violation.path}:${violation.line} ${violation.kind}: ${violation.className} — ${violation.text}`
      );
    }
    console.error(
      "Define or remove the hook, or document an exact intentional nonvisual hook/finite dynamic contract. Do not add broad file/prefix exemptions."
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
