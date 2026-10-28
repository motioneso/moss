import { spawn } from "node:child_process";

export function runCapture(command: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let stdout = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"] });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with status ${code ?? "unknown"}`));
    });
  });
}

/**
 * #1024/#1000: positive proof that `down -v` actually left nothing behind — the Phase 1
 * acceptance criterion is "tears down clean (no leftover containers/volumes/networks)", not just
 * "the down command exited 0". Throws with the leaked names so a failed run is loud, not a silent
 * resource leak discovered later by `docker system df` creeping up.
 */
export async function assertNoLeakedResources(projectName: string): Promise<void> {
  const leaked = await listOwnedResources(projectName);
  if (leaked.containers.length > 0 || leaked.volumes.length > 0 || leaked.networks.length > 0) {
    throw new Error(
      `UAT teardown leaked resources for ${projectName}: containers=${JSON.stringify(
        leaked.containers
      )} volumes=${JSON.stringify(leaked.volumes)} networks=${JSON.stringify(leaked.networks)}`
    );
  }
}

export async function cleanupUatAttempt(input: {
  readonly teardownCompose: () => Promise<void>;
  readonly assertNoLeaks: () => Promise<void>;
  readonly cleanupEnvFile: () => void;
  readonly beforeTeardown?: () => Promise<void>;
  readonly afterTeardown?: (failed: boolean) => Promise<void>;
  readonly error?: unknown;
}): Promise<void> {
  const errors: unknown[] = Object.hasOwn(input, "error") ? [input.error] : [];
  try {
    for (const cleanup of [
      input.beforeTeardown,
      input.teardownCompose,
      input.assertNoLeaks,
      input.afterTeardown && (() => input.afterTeardown!(errors.length > 0))
    ]) {
      if (!cleanup) continue;
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
  } finally {
    try {
      input.cleanupEnvFile();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "UAT teardown and cleanup failed");
}

export interface OwnedResources {
  readonly containers: readonly string[];
  readonly volumes: readonly string[];
  readonly networks: readonly string[];
}

/** Lists what still exists for one Compose project; empty lists mean nothing is left. */
export async function listOwnedResources(projectName: string): Promise<OwnedResources> {
  const lines = (raw: string) => raw.split("\n").filter(Boolean);
  const [containers, volumes, networks] = await Promise.all([
    runCapture("docker", ["ps", "-a", "--filter", `name=${projectName}`, "--format", "{{.Names}}"]),
    runCapture("docker", [
      "volume",
      "ls",
      "--filter",
      `name=${projectName}`,
      "--format",
      "{{.Name}}"
    ]),
    runCapture("docker", [
      "network",
      "ls",
      "--filter",
      `label=com.docker.compose.project=${projectName}`,
      "--format",
      "{{.Name}}"
    ])
  ]);
  return { containers: lines(containers), volumes: lines(volumes), networks: lines(networks) };
}
