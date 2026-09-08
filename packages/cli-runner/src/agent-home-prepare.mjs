// Runs AS the person's own slot account, through setpriv, never as the
// launcher: this is the only code allowed to create and write anything
// below a person's top-level home or session folder (task 5b, Architect
// ruling on Astra-Reviewer round-four finding, 2026-09-08). Because it runs
// already switched to the person's uid/gid, plain mkdir/writeFile land
// already owned by them — no chown anywhere in this file, and none needed.
//
// Each folder level below the top is still built one segment at a time with
// a symlink check first: a previous command running as this same person
// could have planted a link partway down the path, and a plain recursive
// mkdir silently writes through a link like that into wherever it points
// (proven empirically before writing this). Real privilege never crosses
// this boundary either way — the process is already running as the person —
// but a planted link could still misdirect a write to the wrong folder, so
// every level is still checked.
//
// Invoked with exactly one argv element: a JSON string shaped like
// { dirs: string[], denyFile: null | { path: string, permissionKeys: string[] } }
// Never invoked through a shell, so no interpolation risk.
import { O_CREAT, O_NOFOLLOW, O_RDONLY, O_TRUNC, O_WRONLY } from "node:constants";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { sep } from "node:path";

async function ensureRealDir(path) {
  const stat = await lstat(path).catch(() => null);
  if (stat && stat.isSymbolicLink()) await rm(path, { force: true });
  if (!stat || stat.isSymbolicLink()) {
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    return;
  }
  if (!stat.isDirectory()) throw new Error(`refusing to prepare ${path}: not a real folder`);
}

async function ensureDirTree(path) {
  const parts = path.split(sep).filter((part) => part.length > 0);
  let current = path.startsWith(sep) ? sep : "";
  for (const part of parts) {
    current = current === "" ? part : current === sep ? `${sep}${part}` : `${current}${sep}${part}`;
    await ensureRealDir(current);
  }
}

async function readExistingConfig(path) {
  const handle = await open(path, O_RDONLY | O_NOFOLLOW).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return {};
  try {
    const parsed = JSON.parse(await handle.readFile("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  } finally {
    await handle.close();
  }
}

async function main() {
  const raw = process.argv[2];
  if (!raw) throw new Error("missing preparation request argument");
  const request = JSON.parse(raw);

  for (const dir of request.dirs) {
    await ensureDirTree(dir);
  }

  if (request.denyFile) {
    const { path, permissionKeys } = request.denyFile;
    const first = await lstat(path).catch(() => null);
    if (first && first.isSymbolicLink()) await rm(path, { force: true });
    const config = await readExistingConfig(path);
    const permission =
      config.permission &&
      typeof config.permission === "object" &&
      !Array.isArray(config.permission)
        ? { ...config.permission }
        : {};
    for (const permissionKey of permissionKeys) permission[permissionKey] = "deny";
    config.permission = permission;
    const handle = await open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(config, null, 2), "utf8");
    } finally {
      await handle.close();
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
);
