import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildUiCatalogue,
  formatCatalogueJson,
  formatOptionsDoc
} from "../../scripts/build-ui-catalogue.ts";

/**
 * D5 catalogue guard (#1388 foundation). Covers what the guard's own diff check can't:
 * that extraction is actually correct on fixture components (enum values, both default idioms
 * this codebase uses, boolean flags), the sibling-export false-positive found and fixed while
 * building this (badge.tsx's ComingSoon rendering `<Badge tone="steel">` must not be read as
 * Badge's own default), and — mirroring check-ui-classes.test.ts's acceptance stand-in — that the
 * checked-in packages/ui/catalogue.json and OPTIONS.md match a fresh build of the real tree today.
 */

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function buildFixtureDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "check-ui-catalogue-"));
  fixtureRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, name), contents);
  }
  return root;
}

describe("build-ui-catalogue extraction (#1388)", () => {
  it("extracts enum options with a destructured-parameter default", async () => {
    const dir = await buildFixtureDir({
      "thing.tsx": [
        'export type ThingSize = "sm" | "md" | "lg";',
        "export interface ThingProps { readonly size?: ThingSize; }",
        'export function Thing({ size = "md" }: ThingProps) { return null; }'
      ].join("\n")
    });

    const catalogue = buildUiCatalogue(dir);

    expect(catalogue.items).toHaveLength(1);
    expect(catalogue.items[0]?.options).toEqual([
      { prop: "size", kind: "enum", values: ["sm", "md", "lg"], optional: true, default: "md" }
    ]);
  });

  it('extracts an enum default from the props.x ?? "default" idiom', async () => {
    const dir = await buildFixtureDir({
      "thing.tsx": [
        'export type ThingTone = "neutral" | "steel";',
        "export interface ThingProps { readonly tone?: ThingTone; }",
        "export function Thing(props: ThingProps) {",
        '  const tone = props.tone ?? "neutral";',
        "  return tone;",
        "}"
      ].join("\n")
    });

    const catalogue = buildUiCatalogue(dir);

    expect(catalogue.items[0]?.options).toEqual([
      {
        prop: "tone",
        kind: "enum",
        values: ["neutral", "steel"],
        optional: true,
        default: "neutral"
      }
    ]);
  });

  it("does not mistake a sibling export's JSX usage for the component's own default", async () => {
    // Regression fixture for the badge.tsx/ComingSoon bug: ComingSoon renders <Thing tone="steel">,
    // but Thing's own default (unset here) must not be read as "steel".
    const dir = await buildFixtureDir({
      "thing.tsx": [
        'export type ThingTone = "neutral" | "steel";',
        "export interface ThingProps { readonly tone?: ThingTone; }",
        "export function Thing(props: ThingProps) {",
        "  const tone = props.tone;",
        "  return tone;",
        "}",
        "export function OtherThing() {",
        '  return Thing({ tone: "steel" });',
        "}"
      ].join("\n")
    });

    const catalogue = buildUiCatalogue(dir);

    expect(catalogue.items[0]?.options[0]?.default).toBeNull();
    expect(catalogue.items[0]?.exports).toEqual(["OtherThing", "Thing"]);
  });

  it("extracts boolean props as flags, not options", async () => {
    const dir = await buildFixtureDir({
      "thing.tsx": [
        "export interface ThingProps { readonly disabled?: boolean; readonly checked: boolean; }",
        "export function Thing(props: ThingProps) { return props; }"
      ].join("\n")
    });

    const catalogue = buildUiCatalogue(dir);

    expect(catalogue.items[0]?.options).toEqual([]);
    expect(catalogue.items[0]?.flags).toEqual([
      { prop: "disabled", optional: true },
      { prop: "checked", optional: false }
    ]);
  });

  it("keeps RowIndex options when a later sibling declares item props", async () => {
    const dir = await buildFixtureDir({
      "row-index.tsx": [
        "export interface RowIndexProps {",
        '  readonly variant?: "default" | "facts";',
        '  readonly density?: "default" | "compact";',
        "}",
        "export function RowIndex(props: RowIndexProps) { return props; }",
        "export interface RowIndexItemProps { readonly title: string; }",
        "export function RowIndexItem(props: RowIndexItemProps) { return props; }"
      ].join("\n")
    });

    const catalogue = buildUiCatalogue(dir);

    expect(catalogue.items[0]?.options).toEqual([
      {
        prop: "variant",
        kind: "enum",
        values: ["default", "facts"],
        optional: true,
        default: null
      },
      {
        prop: "density",
        kind: "enum",
        values: ["default", "compact"],
        optional: true,
        default: null
      }
    ]);
    expect(catalogue.items[0]?.exports).toEqual(["RowIndex", "RowIndexItem"]);
  });

  it("preserves the last props interface fallback when no component name matches", async () => {
    const dir = await buildFixtureDir({
      "collection.tsx": [
        "export interface FirstProps { readonly disabled?: boolean; }",
        "export function First(props: FirstProps) { return props; }",
        'export interface LastProps { readonly tone?: "neutral" | "steel"; }',
        "export function Last(props: LastProps) { return props; }"
      ].join("\n")
    });

    const catalogue = buildUiCatalogue(dir);

    expect(catalogue.items[0]?.flags).toEqual([]);
    expect(catalogue.items[0]?.options).toEqual([
      {
        prop: "tone",
        kind: "enum",
        values: ["neutral", "steel"],
        optional: true,
        default: null
      }
    ]);
  });

  it("matches the checked-in packages/ui/catalogue.json and OPTIONS.md against the real tree", async () => {
    const repoRoot = join(import.meta.dirname, "../..");
    const componentsDir = join(repoRoot, "packages/ui/src");

    const catalogue = buildUiCatalogue(componentsDir);
    const freshCatalogueText = await formatCatalogueJson(catalogue);
    const freshOptionsDocText = formatOptionsDoc(catalogue);

    const { readFile } = await import("node:fs/promises");
    const checkedInCatalogueText = await readFile(
      join(repoRoot, "packages/ui/catalogue.json"),
      "utf8"
    );
    const checkedInOptionsDocText = await readFile(
      join(repoRoot, "packages/ui/OPTIONS.md"),
      "utf8"
    );

    expect(checkedInCatalogueText).toBe(freshCatalogueText);
    expect(checkedInOptionsDocText).toBe(freshOptionsDocText);
  });
});
