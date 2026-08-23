// tests/unit/module-web-sdk-ui-smoke.test.tsx
// #1388 Foundation task 11: proves a @moss/ui component renders live through
// @moss/module-web-sdk's re-export + JSX shim, using a test-only fixture module
// (tests/fixtures/module-web-sdk-ui-smoke) rather than editing finance's or job-search's
// real screens. Two halves: bundle hygiene (mirrors
// tests/unit/external-module-finance-bundle.test.ts's web-bundle assertions) and a live
// render of the built bundle's default export through react-test-renderer, proving Button
// and Chip actually mount and produce the expected jds-* DOM (plain node environment, same
// as job-search-overview.test.tsx — no jsdom needed for react-test-renderer).
// .tsx (despite JSX-free source): root tsconfig includes tests/**/*.ts only, so a
// react-importing test uses .tsx by repo convention (see helpers/install-module-runtime.tsx's
// own comment) to stay outside root tsc's stricter, react-typeless scope.
import "./helpers/install-module-runtime";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import { beforeAll, describe, expect, it } from "vitest";

import { buildExternalModule } from "../../scripts/build-external-module.js";

const moduleDir = fileURLToPath(new URL("../fixtures/module-web-sdk-ui-smoke", import.meta.url));

beforeAll(async () => {
  await buildExternalModule(moduleDir);
}, 60_000);

describe("module-web-sdk UI smoke (#1388 Foundation task 11)", () => {
  it("web bundle is browser-only ESM using the host React runtime", () => {
    expect(existsSync(`${moduleDir}/dist/worker.js`)).toBe(true);
    const source = readFileSync(`${moduleDir}/dist/web/index.js`, "utf8");
    expect(source).toContain("__JARVIS_MODULE_RUNTIME__");
    expect(source).toContain("export"); // ESM output
    expect(source).not.toContain("node:"); // no Node/server code
    expect(source).not.toContain("require("); // no CJS/react bundled in
    expect(source).not.toMatch(/react[./-]dom|react\.development|react\.production/);
  });

  it("renders a live @moss/ui Button and Chip through the built bundle", async () => {
    // Cache-bust: a bare path import() would hit Node's ESM module cache on a re-run within
    // the same process (e.g. vitest watch mode) even though beforeAll rebuilt the file.
    const mod = (await import(
      `${pathToFileURL(`${moduleDir}/dist/web/index.js`).href}?t=${Math.random()}`
    )) as {
      default: { contractVersion: number; Root: () => ReactNode; css: string };
    };
    expect(mod.default.contractVersion).toBe(2);

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(createElement(mod.default.Root));
    });

    const button = renderer.root.findAll(
      (node) =>
        typeof node.type === "string" &&
        (node.props as { className?: string }).className === "jds-btn jds-btn--primary"
    );
    expect(button).toHaveLength(1);
    expect(button[0]!.children.join("")).toContain("Smoke");

    const chip = renderer.root.findAll(
      (node) =>
        typeof node.type === "string" &&
        (node.props as { className?: string }).className === "jds-chip"
    );
    expect(chip).toHaveLength(1);

    // lucide-react's X icon, exercised via the aliased bare "react" import path (as opposed to
    // Button's `inject`ed h/Fragment path) — proves both esbuild wiring paths this stretch's
    // fixes touched actually produce a live component, not just a bundle that builds cleanly.
    const svgs = renderer.root.findAllByType("svg");
    expect(svgs).toHaveLength(1);
  });
});
