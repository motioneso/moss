import { createHash } from "node:crypto";
import { mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version, type Loader } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const apiRequire = createRequire(join(root, "apps/api/package.json"));
const compilerRequire = createRequire(import.meta.url);
const recipePath = "infra/computer-gateway/Dockerfile";
const ignorePath = "infra/computer-gateway/.dockerignore";
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Internal packaging only: never invokes Docker or qualifies a runtime/image. */
export async function buildComputerGateway(outputDirectory: string) {
  const sources = new Map<string, Buffer>();
  const controls = new Map<string, Buffer>();
  function localPath(path: string) {
    const local = relative(root, resolve(root, path));
    if (!local || isAbsolute(local) || local === ".." || local.startsWith("../"))
      throw new Error("Computer build input outside repository");
    return local;
  }
  for (const path of [
    recipePath,
    ignorePath,
    "scripts/computer-gateway/build.ts",
    "scripts/build-computer-gateway.ts",
    "package.json",
    "apps/api/package.json",
    "pnpm-lock.yaml",
    compilerRequire.resolve("esbuild/package.json"),
    apiRequire.resolve("ws/package.json"),
    apiRequire.resolve("rfb2/package.json")
  ]) {
    const local = localPath(path);
    controls.set(local, await readFile(join(root, local)));
  }
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["scripts/computer-gateway.ts"],
    outfile: "gateway.cjs",
    platform: "node",
    target: "node24",
    format: "cjs",
    bundle: true,
    write: false,
    metafile: true,
    sourcemap: false,
    tsconfigRaw: {},
    minifySyntax: true,
    define: {
      "process.env.WS_NO_BUFFER_UTIL": '"1"',
      "process.env.WS_NO_UTF_8_VALIDATE": '"1"'
    },
    logLevel: "silent",
    plugins: [
      {
        name: "capture-computer-inputs",
        setup(compiler) {
          compiler.onLoad({ filter: /./, namespace: "file" }, async ({ path }) => {
            const extension = extname(path);
            const loaders: Record<string, Loader> = {
              ".ts": "ts",
              ".js": "js",
              ".mjs": "js",
              ".cjs": "js",
              ".json": "json"
            };
            const loader = loaders[extension];
            if (!loader) throw new Error("Unsupported Computer build input");
            const local = localPath(path);
            const contents = await readFile(path);
            sources.set(local, contents);
            return { contents, loader };
          });
        }
      }
    ]
  });
  if (
    result.outputFiles.length !== 1 ||
    Object.values(result.metafile.outputs).some((output) =>
      output.imports.some((item) => !item.external || !isBuiltin(item.path))
    )
  )
    throw new Error("Computer bundle has nonbuiltin runtime dependencies");
  for (const [path, bytes] of [...controls, ...sources]) {
    if (!(await readFile(join(root, path))).equals(bytes))
      throw new Error("Computer build input changed during compilation");
  }
  const hashes = (files: Map<string, Buffer>) =>
    Object.fromEntries(
      [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([p, b]) => [p, sha256(b)])
    );
  const bundle = result.outputFiles[0]!.contents;
  const recipe = controls.get(recipePath)!;
  const ignore = controls.get(ignorePath)!;
  const baseImage = /^FROM (node:[^\s]+@sha256:[a-f0-9]{64})$/m.exec(recipe.toString())?.[1];
  if (!baseImage) throw new Error("Computer base image must be pinned");
  const receipt = {
    format: "cjs",
    target: "node24",
    compiler: { name: "esbuild", version },
    baseImage,
    bundle: { sha256: sha256(bundle), bytes: bundle.byteLength },
    dockerfileSha256: sha256(recipe),
    dockerignoreSha256: sha256(ignore),
    sourceSha256: hashes(sources),
    controlSha256: hashes(controls)
  };
  const output = resolve(outputDirectory);
  await mkdir(output, { mode: 0o700 }); // Exclusive: never overwrite an earlier context or symlink.
  const created: string[] = [];
  try {
    for (const [name, bytes] of [
      ["gateway.cjs", bundle],
      ["Dockerfile", recipe],
      [".dockerignore", ignore],
      ["build.json", JSON.stringify(receipt, null, 2) + "\n"]
    ] as const) {
      const path = join(output, name);
      const file = await open(path, "wx", 0o400);
      created.push(path);
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
    }
  } catch (error) {
    for (const path of created) await unlink(path);
    await rmdir(output);
    throw error;
  }
  return receipt;
}
