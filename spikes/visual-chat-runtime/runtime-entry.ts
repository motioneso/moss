// Evaluation-only integration for the inspected, pinned 1.0.1 web entry.
// Fail visibly on a changed upstream bootstrap rather than silently shipping it.
const bootstrap = /\/\/#region src\/devtoolsBootstrap\.ts[\s\S]*?\/\/#endregion/g;

export function removeDevtoolsBootstrap(source: string): string {
  const matches = [...source.matchAll(bootstrap)];
  if (matches.length !== 1) throw new Error("OpenUI 1.0.1 bootstrap changed; re-evaluate runtime");
  return source.replace(bootstrap, "// Moss evaluation: automatic devtools bootstrap removed.\n");
}

export function prepareRuntimeModule(
  source: string,
  id: string,
  environment: "development" | "production",
  negativeLoader = false
): string | undefined {
  const path = id.split("?")[0];
  if (!path?.includes("/@openuidev/react-lang/dist/") || !path.endsWith(".mjs")) return;
  // Vite's development env replacement misses this vendor's bracket notation.
  const prepared = source.replaceAll('process.env["NODE_ENV"]', JSON.stringify(environment));
  return path.endsWith("/index.mjs") && !negativeLoader
    ? removeDevtoolsBootstrap(prepared)
    : prepared;
}
