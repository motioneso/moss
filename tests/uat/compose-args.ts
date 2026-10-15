const UAT_COMPOSE_FILE = "infra/docker-compose.prod.yml";

// #1024/#1000: every docker invocation MUST go through this so project-name scoping (and
// therefore volume/network isolation, spec §3.3) can never be forgotten at a call site.
export function buildUatComposeArgs(
  projectName: string,
  extra: readonly string[]
): readonly string[] {
  return [
    "compose",
    "-p",
    projectName,
    "-f",
    UAT_COMPOSE_FILE,
    "-f",
    "tests/uat/compose.override.yml",
    ...(process.env.MOSS_NATIVE_SANDBOX === "1"
      ? ["-f", "infra/docker-compose.native-sandbox.yml"]
      : []),
    ...extra
  ];
}
