import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import {
  createLifecycleRecorder,
  type LifecycleAttempt,
  type LifecycleCapture
} from "./lifecycle-records.js";

// The fake implements only read-only metadata commands. Unexpected commands fail closed.
export function lifecycleFixture() {
  const root = mkdtempSync(join(tmpdir(), "n3-lifecycle-"));
  const dir = join(root, "channel");
  mkdirSync(dir, { mode: 0o700 });
  mkdirSync(join(root, "infra"));
  mkdirSync(join(root, "tests", "uat"), { recursive: true });
  for (const path of [
    "Dockerfile",
    ".dockerignore",
    "infra/docker-compose.prod.yml",
    "tests/uat/compose.override.yml"
  ]) {
    writeFileSync(join(root, path), "frozen-input\n");
  }
  const env = {
    JARVIS_UAT_LIFECYCLE_DIR: dir,
    JARVIS_UAT_LIFECYCLE_NONCE: "ab".repeat(32),
    JARVIS_IMAGE_TAG: "uat-unique"
  };
  const attempt: LifecycleAttempt = {
    projectName: "uat-123_abcdef01",
    webPort: 5201,
    composeArgs: [
      "compose",
      "-p",
      "uat-123_abcdef01",
      "-f",
      "infra/docker-compose.prod.yml",
      "-f",
      "tests/uat/compose.override.yml"
    ]
  };
  const id = "1".repeat(64);
  const imageId = `sha256:${"2".repeat(64)}`;
  const reference = "ghcr.io/motioneso/moss:uat-unique";
  const labels = {
    "com.docker.compose.project": attempt.projectName,
    "com.docker.compose.project.working_dir": join(root, "infra"),
    "com.docker.compose.project.config_files": [
      join(root, "infra/docker-compose.prod.yml"),
      join(root, "tests/uat/compose.override.yml")
    ].join(","),
    "com.docker.compose.service": "jarv1s"
  };
  const app = {
    id,
    name: `/${attempt.projectName}-jarv1s-1`,
    created: new Date().toISOString(),
    labels,
    imageId,
    imageReference: reference,
    configuredPorts: { "3000/tcp": [{ HostIp: "", HostPort: "5201" }] },
    ports: { "3000/tcp": [{ HostIp: "127.0.0.1", HostPort: "5201" }] },
    Env: ["SECRET_SENTINEL"],
    Mounts: ["SECRET_SENTINEL"],
    transcript: "SECRET_SENTINEL"
  };
  const volumes = ["jarv1s-cli-auth", "jarv1s-sports-browser-socket", "jarv1s-vault-data"].map(
    (role) => ({
      id: `${attempt.projectName}_${role}`,
      name: `${attempt.projectName}_${role}`,
      created: app.created,
      labels: {
        "com.docker.compose.project": attempt.projectName,
        "com.docker.compose.volume": role
      },
      driver: "local",
      Options: { secret: "SECRET_SENTINEL" }
    })
  );
  const state = {
    built: false,
    appPresent: false,
    volumesPresent: false,
    daemon: "daemon-original",
    lookupError: false,
    inspectError: false,
    networkPresent: false,
    dirty: false,
    extra: false
  };
  const capture: LifecycleCapture = vi.fn(async (command: string, args: readonly string[]) => {
    if (command === "git") {
      if (args.includes("--show-toplevel")) return root;
      if (args.includes("--porcelain")) return state.dirty ? " M Dockerfile" : "";
      if (args.includes("HEAD^{tree}")) return "4".repeat(40);
      if (args.includes("HEAD")) return "3".repeat(40);
    }
    if (command !== "docker") throw new Error("Unexpected executable");
    if (args[0] === "context" && args[1] === "show") return "default";
    if (args[0] === "context" && args[1] === "inspect")
      return JSON.stringify("unix:///var/run/docker.sock");
    if (args[0] === "info") return JSON.stringify(state.daemon);
    if (args[0] === "image" && args[1] === "ls") return state.built ? imageId : "";
    if (args[0] === "image" && args[1] === "inspect")
      return JSON.stringify({ id: imageId, created: app.created });
    if (args.includes("ls") || args[0] === "ps") {
      if (state.lookupError) throw new Error("SECRET_SENTINEL: lookup denied");
      if (args[0] === "volume")
        return state.volumesPresent
          ? volumes.map((v) => v.id).join("\n")
          : state.extra
            ? `${attempt.projectName}_unexpected-volume`
            : "";
      if (args[0] === "network") return state.networkPresent ? "5".repeat(64) : "";
      if (args.some((arg) => arg.startsWith("name="))) return "";
      return state.appPresent ? id : "";
    }
    if (args[1] === "inspect") {
      if (args[0] === "container") return JSON.stringify(app);
      if (args[0] === "network")
        return JSON.stringify({
          id: "5".repeat(64),
          name: `${app.labels["com.docker.compose.project"]}_jarv1s`,
          created: app.created,
          driver: "bridge",
          labels: {
            "com.docker.compose.project": app.labels["com.docker.compose.project"],
            "com.docker.compose.network": "jarv1s"
          }
        });
      if (args[0] === "volume") {
        if (state.inspectError && args[2] === volumes[0]!.id) throw new Error("SECRET_SENTINEL");
        return JSON.stringify(volumes.find((v) => v.id === args[2]));
      }
    }
    throw new Error(`Unexpected metadata command: ${args.slice(0, 2).join(" ")}`);
  });
  const records = () =>
    readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
  return {
    root,
    dir,
    env,
    attempt,
    id,
    imageId,
    reference,
    app,
    volumes,
    state,
    capture,
    records,
    recorder: () => createLifecycleRecorder({ env, root, capture }),
    dispose: () => rmSync(root, { recursive: true, force: true })
  };
}
