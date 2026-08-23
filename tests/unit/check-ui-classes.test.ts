import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { checkUiClasses, WEB_DEFINITION_FILES } from "../../scripts/check-ui-classes.ts";

/**
 * Guard 1/2 regression test (#1388 foundation).
 *
 * The guard's own module-load self-test proves the detector fires on a synthetic bad case
 * (mirrors check-design-tokens.ts's convention). This file adds two things that self-test can't:
 * a real fixture tree exercising the full defined-vs-used comparison end to end, and a check
 * against the actual repo — the acceptance bar the spec sets is "fails on an undefined class,
 * passes on the tree as it stands today" (Phase B already renamed every previously-undefined
 * class this guard would have caught).
 */

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function buildFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "check-ui-classes-"));
  fixtureRoots.push(root);

  await mkdir(join(root, "apps/web/src/widgets"), { recursive: true });
  await mkdir(join(root, "packages/other/src"), { recursive: true });
  await mkdir(join(root, "external-modules/demo/src/web"), { recursive: true });
  await mkdir(join(root, "packages/ui/src/styles"), { recursive: true });

  // Fixture directories/files are derived from the guard's own WEB_DEFINITION_FILES rather than a
  // second hand-maintained copy — a duplicated list drifts the moment the script gains an entry
  // (#1393: components-empty.css/components-forms.css landed in the script but not here, and
  // every check-ui-classes.test.ts case ENOENT'd on the missing fixture file).
  const definitionDirs = new Set(WEB_DEFINITION_FILES.map((relativeFile) => dirname(relativeFile)));
  for (const dir of definitionDirs) {
    await mkdir(join(root, dir), { recursive: true });
  }

  for (const relativeFile of WEB_DEFINITION_FILES) {
    await writeFile(join(root, relativeFile), "");
  }

  await writeFile(
    join(root, "apps/web/src/styles/index.css"),
    ".jds-btn { display: inline-flex; }\n.jds-btn--primary { color: red; }\n"
  );

  return root;
}

describe("check-ui-classes guard (#1388)", () => {
  it("flags a literal jds-* class with no CSS definition", async () => {
    const root = await buildFixture();
    await writeFile(
      join(root, "apps/web/src/widgets/thing.tsx"),
      'export const Thing = () => <button className="jds-btn jds-btn--made-up">Go</button>;\n'
    );

    const result = await checkUiClasses(root);

    expect(result.undefinedClassViolations).toHaveLength(1);
    expect(result.undefinedClassViolations[0]?.className).toBe("jds-btn--made-up");
  });

  it("passes when every literal class is defined", async () => {
    const root = await buildFixture();
    await writeFile(
      join(root, "apps/web/src/widgets/thing.tsx"),
      'export const Thing = () => <button className="jds-btn jds-btn--primary">Go</button>;\n'
    );

    const result = await checkUiClasses(root);

    expect(result.undefinedClassViolations).toEqual([]);
  });

  it("discovers an unregistered package style sheet", async () => {
    const root = await buildFixture();
    await writeFile(
      join(root, "packages/ui/src/styles/components-discovery-probe.css"),
      ".jds-discovery-probe { display: block; }\n"
    );
    await writeFile(
      join(root, "packages/ui/src/discovery-probe.tsx"),
      'export const DiscoveryProbe = () => <div className="jds-discovery-probe">Probe</div>;\n'
    );

    const result = await checkUiClasses(root);

    expect(result.undefinedClassViolations).toEqual([]);
  });

  it("does not flag a complete class immediately followed by an unrelated interpolation", async () => {
    const root = await buildFixture();
    await writeFile(
      join(root, "apps/web/src/widgets/thing.tsx"),
      "export const Thing = (props: { on: boolean }) => " +
        '<button className={`jds-btn jds-btn--primary${props.on ? " jds-btn--active" : ""}`}>Go</button>;\n'
    );
    await writeFile(
      join(root, "apps/web/src/styles/index.css"),
      ".jds-btn { display: inline-flex; }\n.jds-btn--primary { color: red; }\n.jds-btn--active { color: blue; }\n"
    );

    const result = await checkUiClasses(root);

    expect(result.undefinedClassViolations).toEqual([]);
    expect(result.unlistedInterpolationViolations).toEqual([]);
  });

  it("flags an unlisted suffix-interpolation site outside packages/ui", async () => {
    const root = await buildFixture();
    await writeFile(
      join(root, "apps/web/src/widgets/thing.tsx"),
      "export const Thing = (props: { drift: string }) => " +
        "<span className={`jds-drift jds-drift--${props.drift}`}>x</span>;\n"
    );

    const result = await checkUiClasses(root);

    expect(result.unlistedInterpolationViolations).toHaveLength(1);
    expect(result.unlistedInterpolationViolations[0]?.path).toBe("apps/web/src/widgets/thing.tsx");
  });

  it("exempts suffix interpolation inside packages/ui from the burn-down list", async () => {
    const root = await buildFixture();
    await mkdir(join(root, "packages/ui/src"), { recursive: true });
    await writeFile(
      join(root, "packages/ui/src/button.tsx"),
      "export const Button = (props: { variant: string }) => " +
        "<button className={`jds-btn jds-btn--${props.variant}`}>Go</button>;\n"
    );

    const result = await checkUiClasses(root);

    expect(result.unlistedInterpolationViolations).toEqual([]);
  });

  it("passes against the real repo tree", async () => {
    const repoRoot = join(import.meta.dirname, "../..");
    const result = await checkUiClasses(repoRoot);

    expect(result.undefinedClassViolations).toEqual([]);
    expect(result.unlistedInterpolationViolations).toEqual([]);
  });
});
