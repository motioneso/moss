import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

type Scope = "user" | "admin" | "system";

export interface GeneratedSettingsSurface {
  readonly moduleId: string;
  readonly moduleName: string;
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly path: string;
  readonly scope: Scope;
  readonly order: number | null;
  readonly hasEntry: boolean;
}

export interface ScanResult {
  readonly surfaces: readonly GeneratedSettingsSurface[];
  readonly components: Readonly<Record<string, string>>;
  readonly manifestFiles: readonly string[];
}

export interface GeneratedWebRoute {
  readonly moduleId: string;
  readonly moduleName: string;
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly icon: string | null;
  readonly order: number | null;
  readonly permissionId: string | null;
}

export interface WebScanResult {
  readonly routes: readonly GeneratedWebRoute[];
  readonly contributions: Readonly<Record<string, string>>;
  readonly manifestFiles: readonly string[];
}

interface PackageInfo {
  readonly name: string;
  readonly dir: string;
  readonly exports: Readonly<Record<string, unknown>> | undefined;
}

interface ScanOptions {
  readonly rootDir: string;
}

export function scanModuleSettings(options: ScanOptions): ScanResult {
  const surfaces: GeneratedSettingsSurface[] = [];
  const components: Record<string, string> = {};
  const manifestFiles: string[] = [];
  const seenPaths = new Map<string, string>();

  for (const pkg of listModulePackages(options.rootDir)) {
    const manifestFile = join(pkg.dir, "src", "manifest.ts");
    if (!existsSync(manifestFile)) continue;
    manifestFiles.push(manifestFile);

    const manifest = readManifest(manifestFile);
    if (!manifest) continue;

    for (const surface of manifest.settings) {
      const owner = seenPaths.get(surface.path);
      if (owner) {
        throw new Error(
          `duplicate settings path "${surface.path}" claimed by "${owner}" and "${manifest.id}"`
        );
      }
      seenPaths.set(surface.path, manifest.id);

      surfaces.push({
        moduleId: manifest.id,
        moduleName: manifest.name,
        id: surface.id,
        label: surface.label,
        description: surface.description,
        path: surface.path,
        scope: surface.scope,
        order: surface.order ?? null,
        hasEntry: Boolean(surface.entry)
      });

      if (surface.entry) {
        components[manifest.id] =
          `lazy(() => import("${pkg.name}/${normalizeEntry(surface.entry)}"))`;
      }
    }
  }

  return {
    surfaces: surfaces.sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
    components,
    manifestFiles
  };
}

export function emitVirtualModule(result: ScanResult): string {
  const componentEntries = Object.entries(result.components)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([moduleId, loader]) => `  ${JSON.stringify(moduleId)}: ${loader}`)
    .join(",\n");

  return [
    `import { lazy } from "react";`,
    ``,
    `export const MODULE_SETTINGS_SURFACES = ${JSON.stringify(result.surfaces, null, 2)};`,
    `export const MODULE_SETTINGS_COMPONENTS = {`,
    componentEntries,
    `};`,
    ``
  ].join("\n");
}

// Paths owned by the app shell (`apps/web/src/app-route-metadata.ts` `webRoutes`, the entries not
// covered by `MODULE_WEB_ROUTES`). A module manifest declaring one of these would render dead —
// shell <Route>s are declared first in `apps/web/src/app.tsx` and win — and could hijack the
// shell's topbar title via the `startsWith` match in `resolvePageHeading`. Kept as a literal list
// rather than importing from `apps/web` (packages/settings-ui must not depend on the app); a
// drift-guard test (`tests/unit/module-web-reserved-paths.test.ts`) ties this list to the live
// shell route table so the two can't silently diverge.
export const SHELL_RESERVED_WEB_PATHS: readonly string[] = [
  "/today",
  "/tasks",
  "/notifications",
  "/calendar",
  "/wellness",
  "/settings"
];

export function scanModuleWeb(options: ScanOptions): WebScanResult {
  const routes: GeneratedWebRoute[] = [];
  const contributions: Record<string, string> = {};
  const manifestFiles: string[] = [];
  const seenPaths = new Map<string, string>();
  const reservedPaths = new Set(SHELL_RESERVED_WEB_PATHS);

  for (const pkg of listModulePackages(options.rootDir)) {
    if (!pkg.exports || !("./web" in pkg.exports)) continue;

    const manifestFile = join(pkg.dir, "src", "manifest.ts");
    if (!existsSync(manifestFile)) {
      throw new Error(`package "${pkg.name}" declares a "./web" export but has no src/manifest.ts`);
    }
    manifestFiles.push(manifestFile);

    const manifest = readWebManifest(manifestFile);
    if (!manifest) {
      throw new Error(
        `package "${pkg.name}" declares a "./web" export but its manifest could not be parsed`
      );
    }

    for (const entry of manifest.navigation) {
      if (reservedPaths.has(entry.path)) {
        throw new Error(
          `module web route path "${entry.path}" is reserved by the app shell and cannot be claimed by "${manifest.id}"`
        );
      }
      const owner = seenPaths.get(entry.path);
      if (owner) {
        throw new Error(
          `duplicate web route path "${entry.path}" claimed by "${owner}" and "${manifest.id}"`
        );
      }
      seenPaths.set(entry.path, manifest.id);

      routes.push({
        moduleId: manifest.id,
        moduleName: manifest.name,
        id: entry.id,
        label: entry.label,
        path: entry.path,
        icon: entry.icon ?? null,
        order: entry.order ?? null,
        permissionId: entry.permissionId ?? null
      });
    }

    contributions[manifest.id] = `() => import(${JSON.stringify(`${pkg.name}/web`)})`;
  }

  return {
    routes: routes.sort((a, b) => a.moduleId.localeCompare(b.moduleId)),
    contributions,
    manifestFiles
  };
}

export function emitWebVirtualModule(result: WebScanResult): string {
  const contributionEntries = Object.entries(result.contributions)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([moduleId, loader]) => `  { moduleId: ${JSON.stringify(moduleId)}, load: ${loader} }`)
    .join(",\n");

  return [
    `export const MODULE_WEB_ROUTES = ${JSON.stringify(result.routes, null, 2)};`,
    `export const MODULE_WEB_CONTRIBUTIONS = [`,
    contributionEntries,
    `];`,
    ``
  ].join("\n");
}

function listModulePackages(rootDir: string): PackageInfo[] {
  return [
    ...readPackageJsons(join(rootDir, "packages")),
    ...readPackageJsons(join(rootDir, "node_modules"), /^@moss-/),
    ...readScopedPackageJsons(join(rootDir, "node_modules", "@moss"))
  ]
    .filter((pkg) => pkg.name.startsWith("@moss/") || pkg.name.startsWith("@moss-"))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readPackageJsons(parentDir: string, namePattern?: RegExp): PackageInfo[] {
  if (!existsSync(parentDir)) return [];
  return readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (!namePattern || namePattern.test(entry.name)))
    .flatMap((entry) => readPackageInfo(join(parentDir, entry.name)));
}

function readScopedPackageJsons(parentDir: string): PackageInfo[] {
  if (!existsSync(parentDir)) return [];
  return readdirSync(parentDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readPackageInfo(join(parentDir, entry.name)));
}

function readPackageInfo(dir: string): PackageInfo[] {
  const packageJson = join(dir, "package.json");
  if (!existsSync(packageJson)) return [];
  const parsed = JSON.parse(readFileSync(packageJson, "utf8")) as {
    readonly name?: unknown;
    readonly exports?: unknown;
  };
  if (typeof parsed.name !== "string") return [];
  const exports =
    parsed.exports && typeof parsed.exports === "object" && !Array.isArray(parsed.exports)
      ? (parsed.exports as Record<string, unknown>)
      : undefined;
  return [{ name: parsed.name, dir, exports }];
}

interface ParsedManifest {
  readonly id: string;
  readonly name: string;
  readonly settings: readonly ParsedSurface[];
}

interface ParsedSurface {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly path: string;
  readonly scope: Scope;
  readonly order?: number;
  readonly entry?: string;
}

function readManifest(manifestFile: string): ParsedManifest | null {
  const sourceFile = ts.createSourceFile(
    manifestFile,
    readFileSync(manifestFile, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const constants = readStringConstants(sourceFile);

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer ? unwrap(declaration.initializer) : undefined;
      if (!initializer || !ts.isObjectLiteralExpression(initializer)) continue;
      const settings = readArrayProperty(initializer, "settings");
      if (!settings) continue;
      const id = readStringProperty(initializer, "id", constants);
      const name = readStringProperty(initializer, "name", constants);
      if (!id || !name) continue;
      return {
        id,
        name,
        settings: settings
          .map((item) => readSurface(item, constants))
          .filter((surface): surface is ParsedSurface => Boolean(surface))
      };
    }
  }

  return null;
}

interface ParsedWebManifest {
  readonly id: string;
  readonly name: string;
  readonly navigation: readonly ParsedNavigationEntry[];
}

interface ParsedNavigationEntry {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly icon?: string;
  readonly order?: number;
  readonly permissionId?: string;
}

function readWebManifest(manifestFile: string): ParsedWebManifest | null {
  const sourceFile = ts.createSourceFile(
    manifestFile,
    readFileSync(manifestFile, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const constants = readStringConstants(sourceFile);

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializer = declaration.initializer ? unwrap(declaration.initializer) : undefined;
      if (!initializer || !ts.isObjectLiteralExpression(initializer)) continue;
      // Every MossModuleManifest declares a required `lifecycle` field, which disambiguates
      // the manifest object literal from other top-level consts in the same file (e.g. TTL
      // constants, module ids) without requiring `navigation` itself to be present — navigation
      // is optional on the manifest type, unlike `settings` in the sibling settings scanner.
      const lifecycle = readStringProperty(initializer, "lifecycle", constants);
      if (!lifecycle) continue;
      const id = readStringProperty(initializer, "id", constants);
      const name = readStringProperty(initializer, "name", constants);
      if (!id || !name) continue;
      const navigation = readArrayProperty(initializer, "navigation") ?? [];
      return {
        id,
        name,
        navigation: navigation
          .map((item) => readNavigationEntry(item, constants))
          .filter((entry): entry is ParsedNavigationEntry => Boolean(entry))
      };
    }
  }

  return null;
}

function readNavigationEntry(
  node: ts.Expression,
  constants: ReadonlyMap<string, string>
): ParsedNavigationEntry | null {
  const item = unwrap(node);
  if (!ts.isObjectLiteralExpression(item)) return null;
  const id = readStringProperty(item, "id", constants);
  const label = readStringProperty(item, "label", constants);
  const path = readStringProperty(item, "path", constants);
  if (!id || !label || !path) return null;

  return {
    id,
    label,
    path,
    icon: readStringProperty(item, "icon", constants),
    order: readNumberProperty(item, "order"),
    permissionId: readStringProperty(item, "permissionId", constants)
  };
}

function readStringConstants(sourceFile: ts.SourceFile): ReadonlyMap<string, string> {
  const constants = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const value = readStringExpression(declaration.initializer, constants);
      if (value !== undefined) constants.set(declaration.name.text, value);
    }
  }
  return constants;
}

function readSurface(
  node: ts.Expression,
  constants: ReadonlyMap<string, string>
): ParsedSurface | null {
  const item = unwrap(node);
  if (!ts.isObjectLiteralExpression(item)) return null;
  const id = readStringProperty(item, "id", constants);
  const label = readStringProperty(item, "label", constants);
  const path = readStringProperty(item, "path", constants);
  const scope = readStringProperty(item, "scope", constants);
  if (!id || !label || !path || !isScope(scope)) return null;

  return {
    id,
    label,
    description: readStringProperty(item, "description", constants) ?? "",
    path,
    scope,
    order: readNumberProperty(item, "order"),
    entry: readStringProperty(item, "entry", constants)
  };
}

function readStringProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  constants: ReadonlyMap<string, string>
): string | undefined {
  const property = findProperty(object, name);
  if (!property || !ts.isPropertyAssignment(property)) return undefined;
  return readStringExpression(property.initializer, constants);
}

function readNumberProperty(object: ts.ObjectLiteralExpression, name: string): number | undefined {
  const property = findProperty(object, name);
  if (!property || !ts.isPropertyAssignment(property)) return undefined;
  const initializer = unwrap(property.initializer);
  return ts.isNumericLiteral(initializer) ? Number(initializer.text) : undefined;
}

function readArrayProperty(
  object: ts.ObjectLiteralExpression,
  name: string
): readonly ts.Expression[] | undefined {
  const property = findProperty(object, name);
  if (!property || !ts.isPropertyAssignment(property)) return undefined;
  const initializer = unwrap(property.initializer);
  return ts.isArrayLiteralExpression(initializer) ? initializer.elements : undefined;
}

function findProperty(
  object: ts.ObjectLiteralExpression,
  name: string
): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((property) => {
    if (!ts.isPropertyAssignment(property)) return false;
    const propertyName = property.name;
    return (
      (ts.isIdentifier(propertyName) && propertyName.text === name) ||
      (ts.isStringLiteral(propertyName) && propertyName.text === name)
    );
  });
}

function readStringExpression(
  expression: ts.Expression,
  constants: ReadonlyMap<string, string>
): string | undefined {
  const value = unwrap(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isIdentifier(value)) return constants.get(value.text);
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isScope(value: string | undefined): value is Scope {
  return value === "user" || value === "admin" || value === "system";
}

function normalizeEntry(entry: string): string {
  return entry.replace(/^\.?\//, "");
}
