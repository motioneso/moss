function check(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}

export const DOCKER_HOST = "unix:///var/run/docker.sock";

export function rejectOverrides(env: NodeJS.ProcessEnv): void {
  check(!env.DOCKER_HOST || env.DOCKER_HOST === DOCKER_HOST, "local Docker daemon required");
  for (const key of [
    "DOCKER_CONTEXT",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
    "DOCKER_CONFIG",
    "MOSS_UAT_REAL_CHAT_MODEL",
    "JARVIS_UAT_SEED_CHAT_SCRIPT",
    "MOSS_UAT_SEED_CHAT_SCRIPT",
    "MOSS_APP_ACTIONS_REQUIRE_REAL_PROOF",
    "UAT_DOCKER_SUBNET",
    "MOSS_NATIVE_SANDBOX",
    "MOSS_UAT_NODE_ENV",
    "MOSS_TEST_GOOGLE_CALENDAR_BASE_URL",
    "JARVIS_ENV_FILE",
    "COMPOSE_FILE",
    "COMPOSE_PROJECT_NAME",
    "NODE_OPTIONS",
    "MOSS_UAT_REAL_CHAT_PROVIDER"
  ])
    check(!env[key], `override rejected: ${key}`);
  check(
    !env.JARVIS_UAT_REAL_CHAT_PROVIDER || env.JARVIS_UAT_REAL_CHAT_PROVIDER === "codex",
    "Codex required"
  );
  check(env.JARVIS_UAT_BUILD !== "0" && env.MOSS_UAT_BUILD !== "0", "fresh build required");
}
