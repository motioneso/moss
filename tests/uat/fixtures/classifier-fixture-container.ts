// tests/uat/fixtures/classifier-fixture-container.ts
//
// #2907 (plan 3.5): container lifecycle for the classifier fixture origin. Split out of
// provisioner.ts (file-size gate) and injected with the provisioner's docker runner rather than
// importing it, so there is no cycle. Mirrors the briefing-writer fixture container in
// provisioner.ts.
import { CLASSIFIER_FIXTURE_CONTAINER_PORT } from "./classifier-fixture-server.js";

/** The docker calls the provisioner owns; injected to avoid a module cycle. */
export interface ClassifierFixtureDocker {
  readonly runCommand: (command: string, args: readonly string[]) => Promise<void>;
  readonly runCapture: (command: string, args: readonly string[]) => Promise<string>;
}

export function classifierFixtureContainerName(projectName: string): string {
  return `${projectName}-clsfixture`;
}

/** The URL the `jarv1s` container uses to reach the classifier fixture origin. */
export function classifierFixtureBaseUrlFor(projectName: string): string {
  return `http://${classifierFixtureContainerName(projectName)}:${CLASSIFIER_FIXTURE_CONTAINER_PORT}`;
}

/** The line classifier-fixture-cli.ts prints once its listen() has resolved. */
const CLASSIFIER_FIXTURE_READY_LOG = "[classifier-fixture] listening on";
const CLASSIFIER_FIXTURE_READY_TIMEOUT_MS = 30_000;

export async function startClassifierFixtureContainer(
  projectName: string,
  docker: ClassifierFixtureDocker
): Promise<void> {
  const name = classifierFixtureContainerName(projectName);
  await docker.runCommand("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    `${projectName}_jarv1s`,
    `ghcr.io/motioneso/moss:${process.env.JARVIS_IMAGE_TAG ?? "uat-smoke"}`,
    "node_modules/.bin/tsx",
    "tests/uat/fixtures/classifier-fixture-cli.ts"
  ]);

  const deadline = Date.now() + CLASSIFIER_FIXTURE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const logs = await docker.runCapture("docker", ["logs", name]).catch(() => "");
    if (logs.includes(CLASSIFIER_FIXTURE_READY_LOG)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `classifier fixture container ${name} never reported ready; ` +
      `check \`docker logs ${name}\` before it is removed`
  );
}

/** Removes the classifier fixture container. MUST run before `docker compose down -v`. Idempotent. */
export async function removeClassifierFixtureContainer(
  projectName: string,
  docker: ClassifierFixtureDocker
): Promise<void> {
  await docker
    .runCommand("docker", ["rm", "--force", classifierFixtureContainerName(projectName)])
    .catch(() => {});
}
