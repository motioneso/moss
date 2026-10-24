// Inspected adapter for the pinned 1.0.1 entry. A changed bootstrap requires re-evaluation.
export function prepareOpenUiModule(source: string, id: string, environment: string) {
  const path = id.split("?")[0];
  if (!path?.includes("/@openuidev/react-lang/dist/") || !path.endsWith(".mjs")) return;
  const prepared = source.replaceAll('process.env["NODE_ENV"]', JSON.stringify(environment));
  if (!path.endsWith("/index.mjs")) return prepared;
  const bootstrap = /\/\/#region src\/devtoolsBootstrap\.ts[\s\S]*?\/\/#endregion/g;
  if ([...prepared.matchAll(bootstrap)].length !== 1)
    throw new Error("OpenUI bootstrap changed; re-evaluate the pinned runtime");
  return prepared.replace(bootstrap, "// Moss: automatic devtools bootstrap removed.\n");
}
