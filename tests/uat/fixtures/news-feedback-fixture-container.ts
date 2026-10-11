import { NEWS_FEEDBACK_FIXTURE_PORT } from "./news-feedback-fixture-server.js";

/** The docker calls the provisioner owns; injected to avoid a module cycle. */
export interface NewsFeedbackFixtureDocker {
  readonly runCommand: (command: string, args: readonly string[]) => Promise<void>;
  readonly runCapture: (command: string, args: readonly string[]) => Promise<string>;
}

export function newsFeedbackFixtureContainerName(projectName: string): string {
  return `${projectName}-newsfixture`;
}

/** The URL the `jarv1s` container uses to reach the News feedback fixture origin. */
export function newsFeedbackFixtureBaseUrlFor(projectName: string): string {
  return `http://${newsFeedbackFixtureContainerName(projectName)}:${NEWS_FEEDBACK_FIXTURE_PORT}`;
}

/** The line news-feedback-fixture-cli.ts prints once its listen() has resolved. */
const NEWS_FEEDBACK_FIXTURE_READY_LOG = "[news-feedback-fixture] listening on";
const NEWS_FEEDBACK_FIXTURE_READY_TIMEOUT_MS = 30_000;

export async function startNewsFeedbackFixtureContainer(
  projectName: string,
  docker: NewsFeedbackFixtureDocker
): Promise<void> {
  const name = newsFeedbackFixtureContainerName(projectName);
  await docker.runCommand("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    `${projectName}_jarv1s`,
    `ghcr.io/motioneso/moss:${process.env.JARVIS_IMAGE_TAG ?? "uat-smoke"}`,
    "node",
    "--import",
    "tsx",
    "tests/uat/fixtures/news-feedback-fixture-cli.ts"
  ]);

  const deadline = Date.now() + NEWS_FEEDBACK_FIXTURE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const logs = await docker.runCapture("docker", ["logs", name]).catch(() => "");
    if (logs.includes(NEWS_FEEDBACK_FIXTURE_READY_LOG)) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(
    `News feedback fixture container ${name} never reported ready; ` +
      `check \`docker logs ${name}\` before it is removed`
  );
}

/** Removes the News feedback fixture container. MUST run before `docker compose down -v`. Idempotent. */
export async function removeNewsFeedbackFixtureContainer(
  projectName: string,
  docker: NewsFeedbackFixtureDocker
): Promise<void> {
  await docker
    .runCommand("docker", ["rm", "--force", newsFeedbackFixtureContainerName(projectName)])
    .catch(() => {});
}
