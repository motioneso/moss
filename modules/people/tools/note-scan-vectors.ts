// Record the legacy vault walk on real synthetic folders; no database is used.
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { listVaultFilesRecursive, VaultContextRunner } from "@moss/vault";

const cases = [];
for (const paths of [
  [],
  ["a.md", "z.md"],
  ["A/first.md", "A/Nested/deep.md", "A/z.md", "B/second.md", "root.md"],
  ["Notes/People/名.md", "Notes/People/é.md", "Notes/z.md", "résumé.md"],
  ["A/readme.txt", "B/Upper.MD", "C/valid.md", "image.png"],
  [`${"folder/".repeat(32)}deep.md`, "last.md"]
]) {
  const root = await mkdtemp(join(tmpdir(), "moss-people-scan-"));
  const listings: Record<string, { name: string; kind: string }[]> = {};
  try {
    for (const path of paths) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), `# ${path}\n`);
    }
    const list = async (path: string) => {
      const entries = await readdir(join(root, path), { withFileTypes: true });
      // The shared linked-notes host admits directories and lowercase .md files.
      listings[path] = entries.flatMap((entry) =>
        entry.isDirectory()
          ? [{ name: entry.name, kind: "directory" }]
          : entry.isFile() && entry.name.endsWith(".md")
            ? [{ name: entry.name, kind: "file" }]
            : []
      );
      for (const entry of entries)
        if (entry.isDirectory()) await list(path ? `${path}/${entry.name}` : entry.name);
    };
    await list("");
    const runner = new VaultContextRunner(join(root, "private"));
    const expected = await runner.withVaultContextAt(
      { actorUserId: "00000000-0000-4000-8000-000000000127", requestId: "people-scan-oracle" },
      root,
      [root],
      async (context) =>
        (await listVaultFilesRecursive(context)).filter((path) => path.endsWith(".md"))
    );
    cases.push({ listings, expected });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
process.stdout.write(
  await format(JSON.stringify(cases), {
    ...(await resolveConfig(fileURLToPath(import.meta.url))),
    parser: "json"
  })
);
