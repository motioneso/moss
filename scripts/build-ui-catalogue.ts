import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format as prettierFormat, resolveConfig } from "prettier";
import ts from "typescript";

/**
 * Generates the @moss/ui catalogue (D5, #1388 foundation) by parsing each component's own
 * TypeScript source with the compiler API — not a hand-maintained list — so a new variant added
 * to a component's exported union type shows up on the next regeneration, and `check:ui-catalogue`
 * catches a checked-in catalogue that's fallen behind. Shape is adapted from shadcn's
 * registry.json (name/type/files/dependencies) and extended with `options`/`flags`, since D5's
 * whole point is that a names-and-files-only catalogue answers "does this exist" but not "what can
 * I pass it" — the thing that stops a screen from reinventing a variant that already exists.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const componentsDir = resolve(root, "packages/ui/src");
const catalogueOutputPath = resolve(root, "packages/ui/catalogue.json");
const optionsDocOutputPath = resolve(root, "packages/ui/OPTIONS.md");

export interface EnumOption {
  readonly prop: string;
  readonly kind: "enum";
  readonly values: readonly string[];
  readonly optional: boolean;
  readonly default: string | null;
}

export interface BooleanFlag {
  readonly prop: string;
  readonly optional: boolean;
}

export interface CatalogueItem {
  readonly name: string;
  readonly type: "registry:ui";
  readonly files: readonly { readonly path: string; readonly type: "registry:ui" }[];
  readonly dependencies: readonly string[];
  readonly exports: readonly string[];
  readonly options: readonly EnumOption[];
  readonly flags: readonly BooleanFlag[];
}

export interface UiCatalogue {
  readonly $schema: string;
  readonly name: string;
  readonly items: readonly CatalogueItem[];
}

function hasExportModifier(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return (modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function stringLiteralUnionValues(typeNode: ts.TypeNode): readonly string[] | null {
  if (!ts.isUnionTypeNode(typeNode)) return null;
  const values: string[] = [];
  for (const member of typeNode.types) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) return null;
    values.push(member.literal.text);
  }
  return values;
}

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/**
 * Scoped to one component's own function body (never the whole file — a sibling export in the
 * same file, e.g. `ComingSoon` rendering `<Badge tone="steel">`, would otherwise be misread as
 * Badge's own default). Checks both default idioms this codebase uses: `props.x ?? "default"`
 * and a destructured parameter default (`{ x = "default" }`, only matched with a trailing `,`/`}`
 * so a same-named JSX attribute — `tone="steel"` followed by a space, not `,`/`}` — can't match).
 */
function defaultValueFor(scopedText: string, prop: string): string | null {
  const valuePattern = '("(?:[^"\\\\]|\\\\.)*"|true|false)';
  const nullishCoalescing = new RegExp(`\\b${prop}\\s*\\?\\?\\s*${valuePattern}`);
  const destructureDefault = new RegExp(`\\b${prop}\\s*=\\s*${valuePattern}\\s*[,}]`);

  const match = nullishCoalescing.exec(scopedText) ?? destructureDefault.exec(scopedText);
  if (!match || !match[1]) return null;
  return match[1].startsWith('"') ? match[1].slice(1, -1) : match[1];
}

function pascalCaseFromKebab(kebabName: string): string {
  return kebabName
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("");
}

export function buildCatalogueItem(fileName: string, sourceText: string): CatalogueItem {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );

  const componentName = fileName.replace(/\.tsx$/, "");
  const componentFunctionName = pascalCaseFromKebab(componentName);
  const unionAliases = new Map<string, readonly string[]>();
  const relativeImportedTypeNames = new Set<string>();
  const exportedFunctionNames: string[] = [];
  const exportedFunctions = new Map<string, ts.FunctionDeclaration>();
  const dependencies = new Set<string>();
  let propsInterface: ts.InterfaceDeclaration | null = null;
  let componentPropsInterface: ts.InterfaceDeclaration | null = null;

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      if (specifier !== "react" && !specifier.startsWith(".")) dependencies.add(specifier);

      if (specifier.startsWith(".")) {
        const importClause = statement.importClause;
        if (importClause?.name) relativeImportedTypeNames.add(importClause.name.text);
        if (importClause?.namedBindings && ts.isNamedImports(importClause.namedBindings)) {
          for (const element of importClause.namedBindings.elements) {
            relativeImportedTypeNames.add(element.name.text);
          }
        }
      }
    }

    if (ts.isTypeAliasDeclaration(statement) && hasExportModifier(statement)) {
      const values = stringLiteralUnionValues(statement.type);
      if (values) unionAliases.set(statement.name.text, values);
    }

    if (
      ts.isInterfaceDeclaration(statement) &&
      hasExportModifier(statement) &&
      statement.name.text.endsWith("Props")
    ) {
      propsInterface = statement;
      if (statement.name.text === `${componentFunctionName}Props`) {
        componentPropsInterface = statement;
      }
    }

    if (ts.isFunctionDeclaration(statement) && hasExportModifier(statement) && statement.name) {
      exportedFunctionNames.push(statement.name.text);
      exportedFunctions.set(statement.name.text, statement);
    }
  }

  const componentFunction = exportedFunctions.get(componentFunctionName);
  const scopedText = componentFunction ? componentFunction.getText(source) : sourceText;

  const options: EnumOption[] = [];
  const flags: BooleanFlag[] = [];

  // A sibling such as RowIndexItem must not hide RowIndex's options. Keep the last-interface
  // fallback for collection files whose exports do not match their filename.
  for (const member of (componentPropsInterface ?? propsInterface)?.members ?? []) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const name = propertyName(member.name);
    if (!name) continue;
    const optional = Boolean(member.questionToken);

    let enumValues: readonly string[] | null = stringLiteralUnionValues(member.type);
    if (
      !enumValues &&
      ts.isTypeReferenceNode(member.type) &&
      ts.isIdentifier(member.type.typeName)
    ) {
      const typeName = member.type.typeName.text;
      enumValues = unionAliases.get(typeName) ?? null;

      if (!enumValues && relativeImportedTypeNames.has(typeName)) {
        throw new Error(
          `${componentName}: prop "${name}" has type "${typeName}", imported from a sibling ` +
            `component file. build-ui-catalogue.ts only resolves enum unions declared inline in ` +
            `the same file (see #1406) — declare "${typeName}" in ${fileName} instead of importing ` +
            `it, or the catalogue silently drops this prop.`
        );
      }
    }

    if (enumValues) {
      options.push({
        prop: name,
        kind: "enum",
        values: enumValues,
        optional,
        default: defaultValueFor(scopedText, name)
      });
      continue;
    }

    if (member.type.kind === ts.SyntaxKind.BooleanKeyword) {
      flags.push({ prop: name, optional });
    }
  }

  return {
    name: componentName,
    type: "registry:ui",
    files: [{ path: `packages/ui/src/${fileName}`, type: "registry:ui" }],
    dependencies: [...dependencies].sort(),
    exports: exportedFunctionNames.sort(),
    options,
    flags
  };
}

export function buildUiCatalogue(directory: string): UiCatalogue {
  const componentFiles = readdirSync(directory)
    .filter((entry) => entry.endsWith(".tsx"))
    .sort();

  const items = componentFiles.map((fileName) =>
    buildCatalogueItem(fileName, readFileSync(join(directory, fileName), "utf8"))
  );

  return {
    $schema: "https://ui.shadcn.com/schema/registry.json",
    name: "jarv1s-ui",
    items
  };
}

export function formatOptionsDoc(catalogue: UiCatalogue): string {
  const lines: string[] = [
    "# @moss/ui option vocabulary",
    "",
    "Generated by `pnpm build:ui-catalogue` from each component's own exported types — do not",
    "hand-edit. A prop appears here only if its type is a string-literal union (an `options` entry,",
    "with its legal values) or a plain `boolean` (a `flags` entry). This is the authoritative list",
    "of every variant/size/tone/etc. string a component currently accepts; do not invent a value",
    "that isn't listed here, and do not add a raw `jds-*` class as a substitute for one — extend the",
    "component's union type in `packages/ui/src/` instead. See `packages/ui/catalogue.json` for the",
    "machine-readable form (also carries each component's file path and exports).",
    ""
  ];

  for (const item of catalogue.items) {
    lines.push(`## ${item.name}`, "");
    if (item.options.length === 0 && item.flags.length === 0) {
      lines.push("_No enum or boolean props._", "");
      continue;
    }
    for (const option of item.options) {
      const defaultText = option.default !== null ? `, default \`${option.default}\`` : "";
      const optionalText = option.optional ? "optional" : "required";
      lines.push(
        `- **${option.prop}** (${optionalText}${defaultText}): ${option.values.map((value) => `\`${value}\``).join(", ")}`
      );
    }
    for (const flag of item.flags) {
      lines.push(`- **${flag.prop}** (${flag.optional ? "optional" : "required"} boolean flag)`);
    }
    lines.push("");
  }

  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd() + "\n"
  );
}

/**
 * Runs the checked-in JSON through the project's own prettier config before comparing/writing —
 * otherwise `check:ui-catalogue`'s diff would permanently disagree with `pnpm format:check`
 * (JSON.stringify never collapses short arrays onto one line the way prettier does).
 */
export async function formatCatalogueJson(catalogue: UiCatalogue): Promise<string> {
  const config = (await resolveConfig(catalogueOutputPath)) ?? {};
  return prettierFormat(JSON.stringify(catalogue), { ...config, filepath: catalogueOutputPath });
}

export async function writeUiCatalogue(): Promise<void> {
  const catalogue = buildUiCatalogue(componentsDir);
  mkdirSync(dirname(catalogueOutputPath), { recursive: true });
  writeFileSync(catalogueOutputPath, await formatCatalogueJson(catalogue), "utf8");
  writeFileSync(optionsDocOutputPath, formatOptionsDoc(catalogue), "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeUiCatalogue();
  console.log(`Wrote ${catalogueOutputPath} and ${optionsDocOutputPath}`);
}
