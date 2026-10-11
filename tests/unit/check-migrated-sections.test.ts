import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkInlineStyleProperties,
  checkRawClasses
} from "../../scripts/check-migrated-sections.ts";

/**
 * Guards 5/6 regression test (#1388 Foundation). The guard's own module-load self-test proves
 * both detectors fire on a synthetic bad case; this file adds real fixture files and the
 * day-one-empty-list acceptance bar the spec sets for every burn-down guard in this epic.
 */

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function buildFixture(tsxContents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "check-migrated-sections-"));
  fixtureRoots.push(root);
  await mkdir(join(root, "apps/web/src/widgets"), { recursive: true });
  await writeFile(join(root, "apps/web/src/widgets/thing.tsx"), tsxContents);
  return root;
}

describe("check-migrated-sections guard 5: raw jds-* class ban", () => {
  it("flags a raw jds-* class in a migrated section, even if the class is defined", async () => {
    const root = await buildFixture(
      'export const Thing = () => <button className="jds-btn jds-btn--primary">Go</button>;\n'
    );

    const violations = await checkRawClasses(root, ["apps/web/src/widgets/thing.tsx"]);

    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.className)).toEqual(["jds-btn", "jds-btn--primary"]);
  });

  it("does not flag a file that is not in the migrated-sections list", async () => {
    const root = await buildFixture(
      'export const Thing = () => <button className="jds-btn">Go</button>;\n'
    );

    const violations = await checkRawClasses(root, []);

    expect(violations).toEqual([]);
  });

  it("still flags a hand-written jds-badge string (Badge is exported from packages/ui)", async () => {
    const root = await buildFixture(
      'export const Thing = () => <span className="jds-badge jds-badge--forest">New</span>;\n'
    );

    const violations = await checkRawClasses(root, ["apps/web/src/widgets/thing.tsx"]);

    expect(violations.map((v) => v.className)).toEqual(["jds-badge", "jds-badge--forest"]);
  });

  it("flags the actual NavIndex class family and its elements", async () => {
    const root = await buildFixture(
      'export const Thing = () => <nav className="jds-navindex"><span className="jds-navindex__label" /></nav>;\n'
    );
    const violations = await checkRawClasses(root, ["apps/web/src/widgets/thing.tsx"]);
    // The existing scanner reports the mapped family prefix for BEM elements.
    expect(violations.map((v) => v.className)).toEqual(["jds-navindex", "jds-navindex"]);
  });

  it("does not flag a class family with no backing component (ruling #1387, option 1)", async () => {
    const root = await buildFixture(
      'export const Thing = () => <section className="jds-brief"><div className="jds-task jds-task__title" /></section>;\n'
    );

    const violations = await checkRawClasses(root, ["apps/web/src/widgets/thing.tsx"]);

    expect(violations).toEqual([]);
  });
});

describe("check-migrated-sections guard 6: inline-style banned-property ban", () => {
  it("flags a banned visual property in an inline style", async () => {
    const root = await buildFixture(
      'export const Thing = () => <div style={{ color: "red" }} />;\n'
    );

    const violations = await checkInlineStyleProperties(root, ["apps/web/src/widgets/thing.tsx"]);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.property).toBe("color");
  });

  it("does not flag layout properties inline (D2)", async () => {
    const root = await buildFixture(
      'export const Thing = () => <div style={{ display: "flex", gap: 8, position: "relative" }} />;\n'
    );

    const violations = await checkInlineStyleProperties(root, ["apps/web/src/widgets/thing.tsx"]);

    expect(violations).toEqual([]);
  });

  it("does not flag a file that is not in the migrated-sections list", async () => {
    const root = await buildFixture(
      'export const Thing = () => <div style={{ color: "red" }} />;\n'
    );

    const violations = await checkInlineStyleProperties(root, []);

    expect(violations).toEqual([]);
  });
});

describe("check-migrated-sections passes against the real repo tree", () => {
  it("real migrated-sections list produces no violations", async () => {
    const repoRoot = join(import.meta.dirname, "../..");
    const rawClassViolations = await checkRawClasses(repoRoot);
    const inlineStyleViolations = await checkInlineStyleProperties(repoRoot);

    expect(rawClassViolations).toEqual([]);
    expect(inlineStyleViolations).toEqual([]);
  });
});
