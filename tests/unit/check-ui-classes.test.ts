import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  checkModuleLocalClasses,
  checkUiClasses,
  WEB_DEFINITION_FILES
} from "../../scripts/check-ui-classes.ts";

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
    expect(result.moduleLocalClassViolations).toEqual([]);
  });
});

async function localFixture(source: string, css: string) {
  const root = await buildFixture();
  await mkdir(join(root, "packages/news/src/web"), { recursive: true });
  await writeFile(join(root, "packages/news/src/web/example.tsx"), source);
  await writeFile(join(root, "packages/news/src/web/example.css"), css);
  return root;
}

describe("bounded module-local class guard", () => {
  it("rejects a missing hook and exact BEM typo", async () => {
    const root = await localFixture(
      '<div className="nw-card nw-card__missing nw-missing" />',
      ".nw-card {} .nw-card__label {}"
    );
    const result = await checkModuleLocalClasses(root);
    expect(result.map((item) => item.className)).toEqual(["nw-card__missing", "nw-missing"]);
  });
  it("does not let an unrelated module or commented selectors define a hook", async () => {
    const root = await localFixture(
      '<div className="nw-leaked nw-comment" />',
      "/* .nw-comment {} */"
    );
    await mkdir(join(root, "packages/sports/src/web"), { recursive: true });
    await writeFile(join(root, "packages/sports/src/web/example.css"), ".nw-leaked {}");
    expect((await checkModuleLocalClasses(root)).map((item) => item.className)).toEqual([
      "nw-leaked",
      "nw-comment"
    ]);
  });
  it("does not treat quoted content or feature-query selectors as definitions", async () => {
    const root = await localFixture(
      '<div className="nw-quoted nw-feature" />',
      '.nw-real::after { content: ".nw-quoted {}"; } @supports selector(.nw-feature) { .nw-real {} }'
    );
    expect((await checkModuleLocalClasses(root)).map((item) => item.className)).toEqual([
      "nw-quoted",
      "nw-feature"
    ]);
  });
  it("checks both conditional branches and class arrays including push variants", async () => {
    const root = await localFixture(
      'function Example({on}) { const names = ["nw-card", on ? "nw-card--ready" : "nw-card--typo"]; if(on) names.push("nw-card--added"); return <div className={names.filter(Boolean).join(" ")} />; }',
      ".nw-card {} .nw-card--ready {} .nw-card--added {}"
    );
    expect((await checkModuleLocalClasses(root)).map((item) => item.className)).toEqual([
      "nw-card--typo"
    ]);
  });
  it("does not mistake JSX attribute names for references to a className array", async () => {
    const root = await localFixture(
      'function Example() { const className = ["nw-card"]; return <div className={className.join(" ")}><span className="nw-card" /></div>; }',
      ".nw-card {}"
    );
    expect(await checkModuleLocalClasses(root)).toEqual([]);
  });
  it("reports unsupported reassignment instead of trusting an earlier valid initializer", async () => {
    const root = await localFixture(
      'function Example() { let names = "nw-card"; names = "nw-missing"; return <div className={names} />; }',
      ".nw-card {}"
    );
    expect(
      (await checkModuleLocalClasses(root)).some((item) => item.kind === "unresolved-expression")
    ).toBe(true);
  });
  it("checks each declared dynamic variant and rejects unregistered interpolation", async () => {
    const path = "packages/news/src/web/example.tsx";
    const root = await localFixture(
      "<div className={`nw-art nw-art--${kind}`} />",
      ".nw-art {} .nw-art--photo {}"
    );
    const unknown = await checkModuleLocalClasses(root);
    expect(unknown.some((item) => item.kind === "unresolved-expression")).toBe(true);
    const result = await checkModuleLocalClasses(root, {
      dynamicValues: [
        {
          path,
          expression: "kind",
          values: ["photo", "missing"],
          reason: "Finite artwork categories"
        }
      ]
    });
    expect(result.map((item) => item.className)).toEqual(["nw-art--missing"]);
  });
  it("allows only exact documented structural hooks and still rejects other missing hooks", async () => {
    const root = await localFixture('<div className="nw-structural nw-other" />', "");
    const result = await checkModuleLocalClasses(root, {
      structuralHooks: [
        {
          path: "packages/news/src/web/example.tsx",
          className: "nw-structural",
          reason: "Intentional automation locator, no visual rule"
        }
      ]
    });
    expect(result.map((item) => item.className)).toEqual(["nw-other"]);
  });
  it.each([
    'const names = "nw-card"; function Example({ names }) { return <div className={names} />; }',
    'const names = "nw-card"; const Example = ({ names }) => <div className={names} />;',
    'function Example() { const names = ["nw-card"]; function alter() { names.push("nw-missing"); } alter(); return <div className={names.join(" ")} />; }',
    'function Example() { const names = ["nw-card"]; const alias = names; alias.push("nw-missing"); return <div className={names.join(" ")} />; }',
    'function Example({on}) { return <div className={`nw-card${on && " "}`} />; }',
    "<div className={`nw-card${null}`} />",
    '<div className={"nw-card" + false} />',
    '<div className={["nw-card", "nw-second"]} />',
    'const names = "nw-card"; try {} catch (names) { const element = <div className={names} />; }',
    'function Example() { const names = ["nw-card"]; mutate({names}); return <div className={names.join(" ")} />; }',
    'function Example({count}) { return <div className={count && "nw-card"} />; }',
    'function Example() { const names = ["nw-card"]; names.filter((value,index,array) => { array.push("nw-missing"); return false; }); return <div className={names.join(" ")} />; }',
    'function Example({Boolean}) { const names = ["nw-card"]; names.filter(Boolean); return <div className={names.join(" ")} />; }'
  ])("fails closed for unsupported binding, mutation or string coercion: %s", async (source) => {
    const root = await localFixture(source, ".nw-card {} .nw-second {}");
    expect(
      (await checkModuleLocalClasses(root)).some((item) => item.kind === "unresolved-expression")
    ).toBe(true);
  });
  it("preserves the exact Meetings provisional-contrast test hook without excusing siblings", async () => {
    const root = await buildFixture();
    await mkdir(join(root, "packages/meetings/src/web"), { recursive: true });
    await writeFile(
      join(root, "packages/meetings/src/web/meeting-transcript.tsx"),
      '<div className="meetings-transcript-turn--live meetings-transcript-turn--typo" />'
    );
    expect((await checkModuleLocalClasses(root)).map((item) => item.className)).toEqual([
      "meetings-transcript-turn--typo"
    ]);
  });
  it("reads Finance's static module stylesheet and ignores source comments", async () => {
    const root = await buildFixture();
    await mkdir(join(root, "external-modules/finance/src/web"), { recursive: true });
    await writeFile(
      join(root, "external-modules/finance/src/web/styles.ts"),
      "export const MODULE_STYLES = `.fnm-card { display: block; }`;"
    );
    await writeFile(
      join(root, "external-modules/finance/src/web/example.tsx"),
      '// <div className="fnm-comment" />\nexport const Example = () => <div className="fnm-card" />;'
    );
    expect(await checkModuleLocalClasses(root)).toEqual([]);
  });
});
