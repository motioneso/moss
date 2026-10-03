import { BRIEFING_WRITER_FIXTURE_CONTAINER_PORT } from "./fixtures/briefing-writer-fixture-server.js";

export interface FixtureRunners {
  readonly runCommand: (command: string, args: readonly string[]) => Promise<void>;
  readonly runCapture: (command: string, args: readonly string[]) => Promise<string>;
}

/**
 * [task:p8-briefing-writer-unreachable]: same in-network container shape as the job-search
 * fixture above, on its own name and port. The worker's synthesis call reaches it by name.
 */
export function briefingWriterFixtureContainerName(projectName: string): string {
  return `${projectName}-bwfixture`;
}

/** The URL the `jarv1s` worker container uses to reach the briefing-writer origin. */
export function briefingWriterFixtureBaseUrlFor(projectName: string): string {
  return `http://${briefingWriterFixtureContainerName(projectName)}:${BRIEFING_WRITER_FIXTURE_CONTAINER_PORT}`;
}

/** The line briefing-writer-fixture-cli.ts prints once its listen() has resolved. */
const BRIEFING_WRITER_FIXTURE_READY_LOG = "[briefing-writer-fixture] listening on";
const BRIEFING_WRITER_FIXTURE_READY_TIMEOUT_MS = 30_000;

/**
 * [task:p8-briefing-writer-unreachable]: starts the briefing-writer fixture origin and waits
 * for its readiness line. A fixture that dies at startup surfaces here as a named timeout,
 * not later as a fallback dump with no obvious cause.
 */
export async function startBriefingWriterFixtureContainer(
  projectName: string,
  { runCommand, runCapture }: FixtureRunners
): Promise<void> {
  const name = briefingWriterFixtureContainerName(projectName);
  await runCommand("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    `${projectName}_jarv1s`,
    `ghcr.io/motioneso/moss:${process.env.JARVIS_IMAGE_TAG ?? "uat-smoke"}`,
    "node_modules/.bin/tsx",
    "tests/uat/fixtures/briefing-writer-fixture-cli.ts"
  ]);

  const deadline = Date.now() + BRIEFING_WRITER_FIXTURE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const logs = await runCapture("docker", ["logs", name]).catch(() => "");
    if (logs.includes(BRIEFING_WRITER_FIXTURE_READY_LOG)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `briefing-writer fixture container ${name} never reported ready; ` +
      `check \`docker logs ${name}\` before it is removed`
  );
}

/** Removes the briefing-writer fixture container. MUST run before `docker compose down -v`. Idempotent and never throws. */
export async function removeBriefingWriterFixtureContainer(
  projectName: string,
  runCommand: FixtureRunners["runCommand"]
): Promise<void> {
  await runCommand("docker", [
    "rm",
    "--force",
    briefingWriterFixtureContainerName(projectName)
  ]).catch(() => {});
}
