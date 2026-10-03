import { classifierMcpFixtureContainerName } from "./fixtures/classifier-mcp-fixture-server.js";

type RunCommand = (command: string, args: readonly string[]) => Promise<void>;

export interface ClassifierMcpFixtureRunners {
  readonly runCommand: RunCommand;
  readonly runCapture: (command: string, args: readonly string[]) => Promise<string>;
}

/** The line classifier-mcp-fixture-cli.ts prints once its listen() has resolved. */
const READY_LOG = "[classifier-mcp-fixture] listening on";
const READY_TIMEOUT_MS = 30_000;

/**
 * Plan 2b.6 (#2936): starts the fake tool server the classifier-integrations spec connects to
 * through the integrations screen. Same in-network container shape as the other fixtures.
 */
export async function startClassifierMcpFixtureContainer(
  projectName: string,
  run: ClassifierMcpFixtureRunners
): Promise<void> {
  const name = classifierMcpFixtureContainerName(projectName);
  await run.runCommand("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    `${projectName}_jarv1s`,
    `ghcr.io/motioneso/moss:${process.env.JARVIS_IMAGE_TAG ?? "uat-smoke"}`,
    "node_modules/.bin/tsx",
    "tests/uat/fixtures/classifier-mcp-fixture-cli.ts"
  ]);

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const logs = await run.runCapture("docker", ["logs", name]).catch(() => "");
    if (logs.includes(READY_LOG)) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `classifier tool-server fixture container ${name} never reported ready; ` +
      `check \`docker logs ${name}\` before it is removed`
  );
}

/** Removes the tool-server fixture container. MUST run before `docker compose down -v`. */
export async function removeClassifierMcpFixtureContainer(
  projectName: string,
  runCommand: RunCommand
): Promise<void> {
  await runCommand("docker", [
    "rm",
    "--force",
    classifierMcpFixtureContainerName(projectName)
  ]).catch(() => {});
}
