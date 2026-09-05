import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = "/attempt/module";
const WEB_ROOT = `${ROOT}/dist/web`;

/** Build and load the generated web contribution using the production recipe. */
export async function buildAndCheckWeb() {
  const output = `${WEB_ROOT}/index.mjs`;
  const metafile = `${ROOT}/dist/web-meta.json`;
  const result = spawnSync(
    "/opt/esbuild",
    [
      "/attempt/module/src/web/index.ts",
      "--bundle",
      "--platform=browser",
      "--format=esm",
      "--target=es2022",
      "--jsx=transform",
      "--jsx-factory=h",
      "--jsx-fragment=Fragment",
      '--tsconfig-raw={"compilerOptions":{"jsx":"react","jsxFactory":"h","jsxFragmentFactory":"Fragment"}}',
      "--inject:/opt/module-web-sdk/runtime.ts",
      "--alias:react=/opt/module-web-sdk/runtime.ts",
      "--alias:react-dom=/opt/module-web-sdk/react-dom-runtime.ts",
      "--alias:@moss/module-web-sdk=/opt/module-web-sdk/index.ts",
      "--alias:@moss/ui=/opt/ui/index.ts",
      "--alias:lucide-react=/opt/lucide-react/dist/esm/lucide-react.js",
      "--alias:@moss/module-sdk/time=/opt/module-sdk/time.ts",
      "--alias:@moss/module-sdk/list-limits=/opt/module-sdk/list-limits.ts",
      "--loader:.css=text",
      `--outfile=${output}`,
      `--metafile=${metafile}`
    ],
    { encoding: "utf8", timeout: 15_000, maxBuffer: 65_536 }
  );
  assert.equal(result.status, 0, `web bundle failed: ${result.stderr.slice(0, 4000)}`);

  const bundle = await readFile(output, "utf8");
  const metadata = JSON.parse(await readFile(metafile, "utf8"));
  const inputs = Object.keys(metadata.inputs ?? {});
  assert.ok(inputs.length > 0, "web bundle metafile has no inputs");
  assert.ok(
    inputs.every(
      (input) => !/(?:^|[/\\])node_modules[/\\]react(?:[/\\]|$)|react[.]production/.test(input)
    ),
    "web bundle must not include a real React implementation"
  );
  assert.ok(
    Object.values(metadata.outputs ?? {}).every((entry) => (entry.imports ?? []).length === 0),
    "web bundle must not retain external imports"
  );
  assert.match(bundle, /__JARVIS_MODULE_RUNTIME__/);
  assert.match(bundle, /\bexport\b/);
  assert.doesNotMatch(bundle, /(?:^|["'])node:/);
  assert.doesNotMatch(bundle, /\brequire\s*\(/);

  const loaded = await import(`${pathToFileURL(output).href}?proof=${Date.now()}`);
  const contribution = loaded.default;
  assert.equal(contribution?.contractVersion, 2);
  assert.equal(typeof contribution?.Root, "function");
  assert.equal(typeof contribution?.css, "string");
  assert.match(contribution.css, /\.workshop-word/);
  console.log(JSON.stringify({ check: "web-bundle-build-and-contract-load", status: "pass" }));
}
