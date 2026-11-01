import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Generate an offline review artifact without adding dependencies or app routes.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const output = resolve(process.argv[2] ?? "/tmp/moss-outlook-user-setup.html");
const result = await build({
  absWorkingDir: root,
  entryPoints: [resolve(here, "mockup.jsx")],
  alias: { "@moss/ui": resolve(root, "packages/ui/src/index.ts") },
  nodePaths: [resolve(root, "apps/web/node_modules")],
  bundle: true,
  write: false,
  outdir: "/virtual",
  minify: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  external: ["/fonts/*"]
});
let css = result.outputFiles.find((file) => file.path.endsWith(".css")).text;
for (const match of [...css.matchAll(/url\((?:")?(\/fonts\/[^)"]+)(?:")?\)/g)]) {
  const font = await readFile(resolve(root, "apps/web/public", `.${match[1]}`));
  css = css.replace(match[0], `url(data:font/woff2;base64,${font.toString("base64")})`);
}
const js = result.outputFiles.find((file) => file.path.endsWith(".js")).text;
await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Outlook setup design review</title><style>${css}</style><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script></html>`
);
console.log(output);
