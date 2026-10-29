import { readdir, readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

async function bytes(mode) {
  const directory = new URL(`./dist/${mode}/assets/`, import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".js"));
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const buffer = await readFile(new URL(file, directory));
    raw += buffer.length;
    gzip += gzipSync(buffer).length;
  }
  return { raw, gzip };
}
const baseline = await bytes("baseline");
const runtime = await bytes("runtime");
console.log(
  JSON.stringify(
    {
      baseline,
      runtime,
      incremental: { raw: runtime.raw - baseline.raw, gzip: runtime.gzip - baseline.gzip }
    },
    null,
    2
  )
);
