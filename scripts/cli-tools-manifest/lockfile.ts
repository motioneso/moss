// Lockfile generation and structural checks (spec 4.1 step 3).
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Runs `npm` (never a shell) in a directory. Injected so tests need no network. */
export type RunNpm = (args: readonly string[], cwd: string) => Promise<void>;

interface Lockfile {
  readonly packages?: Record<
    string,
    { integrity?: string; link?: boolean; version?: string; name?: string; resolved?: string }
  >;
}

export interface LockEntry {
  readonly key: string;
  /** The real package name. For an alias this is the package the entry actually downloads. */
  readonly name: string;
  /** The name it is installed under, taken from the install path. */
  readonly installedAs: string;
  readonly version: string;
  readonly resolved: string;
  readonly integrity: string;
  /** True when the entry installs one package under another package's name. */
  readonly aliased: boolean;
}

/** Every downloadable entry in the lockfile. Entries missing a field are returned with "". */
export function listLockEntries(raw: string): LockEntry[] {
  const lock = JSON.parse(raw) as Lockfile;
  return Object.entries(lock.packages ?? {})
    .filter(([key, meta]) => key !== "" && !meta.link)
    .map(([key, meta]) => {
      const tail = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      return {
        key,
        name: meta.name ?? tail,
        installedAs: tail,
        version: meta.version ?? "",
        resolved: meta.resolved ?? "",
        integrity: meta.integrity ?? "",
        aliased: meta.name !== undefined && meta.name !== tail
      };
    });
}

export async function generateLockfile(
  runNpm: RunNpm,
  pkg: string,
  version: string
): Promise<{ readonly dir: string; readonly lockfile: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "cli-tools-lock-"));
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "cli-tools-scratch", private: true })
  );
  await runNpm(["install", `${pkg}@${version}`, "--package-lock-only", "--ignore-scripts"], dir);
  return { dir, lockfile: await readFile(path.join(dir, "package-lock.json"), "utf8") };
}

/** Every resolved entry must carry a sha512 integrity. Returns one message per problem. */
export function assertLockfileIntegrity(raw: string): string[] {
  let lock: Lockfile;
  try {
    lock = JSON.parse(raw) as Lockfile;
  } catch {
    return ["lockfile is not valid JSON"];
  }
  const entries = Object.entries(lock.packages ?? {}).filter(([key]) => key !== "");
  if (entries.length === 0) return ["lockfile has no packages"];
  const errors: string[] = [];
  for (const [key, meta] of entries) {
    if (meta.link) continue;
    if (typeof meta.integrity !== "string" || !meta.integrity.startsWith("sha512-")) {
      errors.push(`${key} has no sha512 integrity`);
    }
  }
  return errors;
}

/** The requested top-level package must resolve to exactly the requested version. */
export function assertPinnedVersion(raw: string, pkg: string, version: string): string[] {
  const lock = JSON.parse(raw) as Lockfile;
  const entry = lock.packages?.[`node_modules/${pkg}`];
  return entry?.version === version
    ? []
    : [`${pkg} does not resolve to ${version} in the lockfile`];
}

/** Every per-arch native package the catalog names must still exist in the tree. */
export function assertArchPackages(raw: string, archPackages: readonly string[]): string[] {
  const lock = JSON.parse(raw) as Lockfile;
  return archPackages
    .filter((name) => lock.packages?.[`node_modules/${name}`] === undefined)
    .map((name) => `per-arch package ${name} is missing from the lockfile`);
}
