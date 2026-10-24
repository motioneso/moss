import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { isRecord } from "../../apps/api/src/computer/host-contract.js";
import { hostJsonRequest, readHostJson } from "../../apps/api/src/computer/host-http.js";
import { ComputerHostClient } from "../../apps/api/src/computer/host-client.js";
import {
  COMPUTER_IMAGE,
  DIRECTORY_KEYS,
  parseHostConfig,
  type HostConfig
} from "../../scripts/computer-host/config.js";
import { ComputerDocker } from "../../scripts/computer-host/docker.js";
import {
  ComputerHostOperations,
  unavailableAdmission,
  type ComputerRuntimeAdmission
} from "../../scripts/computer-host/operations.js";
import { HostStateStore } from "../../scripts/computer-host/state.js";
import { serveComputerHost } from "../../scripts/computer-host/service.js";

export const OWNER = "10000000-0000-4000-8000-000000000001";
export const FOREIGN = "20000000-0000-4000-8000-000000000002";
export const GATEWAY_IMAGE = `sha256:${"b".repeat(64)}`;
export const NOW = Date.parse("2026-10-24T04:00:00Z");
export const binding = (actorUserId = OWNER) => ({
  actorUserId,
  requestId: "test",
  sessionId: "30000000-0000-4000-8000-000000000003",
  expiresAt: new Date(NOW + 60_000)
});
const defaults = {
  Cmd: ["fixed-entrypoint"],
  Entrypoint: null,
  Env: [],
  WorkingDir: "",
  Healthcheck: null
};
export interface FakeContainer {
  Id: string;
  Name: string;
  Image: string;
  Config: Record<string, unknown>;
  HostConfig: Record<string, unknown>;
  State: { Running: boolean };
  Mounts: Record<string, unknown>[];
  NetworkSettings: { Ports: Record<string, unknown> };
}

/** Recording HTTP Docker stand-in. No real Docker socket or guest process is accessed. */
export async function hostFixture(
  options: { admitted?: boolean; gatewayImage?: string | null } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "moss-host-"));
  const dirs = Object.fromEntries(DIRECTORY_KEYS.map((key) => [key, join(root, key)]));
  for (const path of Object.values(dirs)) await mkdir(path, { mode: 0o700 });
  const config = parseHostConfig({
    ...dirs,
    instanceId: "40000000-0000-4000-8000-000000000004",
    ownerUserId: OWNER,
    dockerSocket: join(root, "docker.sock"),
    gatewayImage: options.gatewayImage === undefined ? GATEWAY_IMAGE : options.gatewayImage
  });
  const containers = new Map<string, FakeContainer>();
  const calls: { method: string; path: string; body: unknown }[] = [];
  const faults = {
    startRole: "",
    exitRole: "",
    unknownCreate: false,
    createWithoutResult: false,
    stop: false,
    missingImage: false,
    imageBytes: 0,
    remove: false,
    removeWithoutResult: false,
    beforeCreateResult: null as (() => Promise<void>) | null,
    holdStart: null as Promise<void> | null
  };
  const dockerServer = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://docker.invalid");
      const path = url.pathname.replace("/v1.47", "");
      const body =
        method === "POST" && Number(request.headers["content-length"]) > 0
          ? await readHostJson(request, 32_768)
          : null;
      calls.push({ method, path: path + url.search, body });
      const send = (status: number, data?: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(data === undefined ? undefined : JSON.stringify(data));
      };
      if (path.startsWith("/images/")) {
        const image = decodeURIComponent(path.slice(8, -5));
        return send(faults.missingImage ? 404 : 200, {
          Id: image,
          Config: defaults,
          padding: "x".repeat(faults.imageBytes)
        });
      }
      if (path === "/containers/json")
        return send(
          200,
          [...containers.values()].map((c) => ({ Id: c.Id }))
        );
      if (path === "/containers/create" && isRecord(body) && isRecord(body.HostConfig)) {
        const id = randomBytes(32).toString("hex");
        const binds = body.HostConfig.Binds;
        if (!Array.isArray(binds)) throw new Error("Fixture expected binds");
        const container: FakeContainer = {
          Id: id,
          Name: `/${url.searchParams.get("name")}`,
          Image: String(body.Image),
          Config: { ...defaults, ...body, HostConfig: undefined },
          HostConfig: body.HostConfig,
          State: { Running: false },
          NetworkSettings: { Ports: {} },
          Mounts: binds.map((bind: string) => {
            const [Source, Destination, mode] = bind.split(":");
            return {
              Type: "bind",
              Source,
              Destination,
              RW: mode === "rw",
              Propagation: "rprivate"
            };
          })
        };
        if (!faults.createWithoutResult) containers.set(id, container);
        await faults.beforeCreateResult?.();
        return send(faults.unknownCreate || faults.createWithoutResult ? 500 : 201, {
          Id: id,
          message: "PRIVATE_DOCKER_SECRET"
        });
      }
      const match = /^\/containers\/([^/]+)(?:\/(json|start|stop|kill))?$/.exec(path);
      const container =
        match &&
        [...containers.values()].find((c) => c.Id === match[1] || c.Name === `/${match[1]}`);
      if (!container) return send(404, { message: "PRIVATE_DOCKER_SECRET" });
      switch (match?.[2]) {
        case "json":
          return send(200, container);
        case "start":
          if (faults.holdStart) await faults.holdStart;
          if (
            container.Config.Labels &&
            isRecord(container.Config.Labels) &&
            container.Config.Labels["com.moss.computer.role"] === faults.startRole
          )
            return send(500);
          container.State.Running = !(
            isRecord(container.Config.Labels) &&
            container.Config.Labels["com.moss.computer.role"] === faults.exitRole
          );
          return send(204);
        case "stop":
          if (faults.stop) return send(500);
          container.State.Running = false;
          return send(204);
        case "kill":
          container.State.Running = false;
          return send(204);
        default:
          if (method !== "DELETE" || container.State.Running || faults.remove) return send(409);
          containers.delete(container.Id);
          if (faults.removeWithoutResult) return response.destroy();
          return send(204);
      }
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => dockerServer.listen(config.dockerSocket, resolve));
  const admission = { assertAdmitted: vi.fn(async () => {}), invalidate: vi.fn(() => {}) };
  const docker = new ComputerDocker(config);
  let store = await HostStateStore.open(config);
  let operations = new ComputerHostOperations(
    store,
    docker,
    options.admitted ? admission : unavailableAdmission
  );
  let service = await serveComputerHost(store, operations);
  let controlOpen = true;
  async function releaseControl() {
    if (!controlOpen) return;
    await service.close();
    await store.close();
    controlOpen = false;
  }
  const assertLive = vi.fn(async () => {});
  const client = new ComputerHostClient({
    socketPath: service.socketPath,
    ownerUserId: OWNER,
    sessions: { assertLive },
    now: () => new Date(NOW)
  });
  const raw = (body: unknown) =>
    hostJsonRequest({
      socketPath: service.socketPath,
      path: "/operation",
      method: "POST",
      body,
      limit: 1024,
      timeoutMs: 120_000
    });
  return {
    config,
    containers,
    calls,
    faults,
    admission,
    client,
    assertLive,
    raw,
    releaseControl,
    get store() {
      return store;
    },
    get operations() {
      return operations;
    },
    get socketPath() {
      return service.socketPath;
    },
    async restart(runtimeAdmission: ComputerRuntimeAdmission = unavailableAdmission) {
      await releaseControl();
      store = await HostStateStore.open(config);
      operations = new ComputerHostOperations(store, docker, runtimeAdmission);
      service = await serveComputerHost(store, operations);
      controlOpen = true;
    },
    async close() {
      await releaseControl();
      dockerServer.closeAllConnections();
      await new Promise<void>((resolve) => dockerServer.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  };
}
export async function isolatedConfig(): Promise<{ config: HostConfig; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "moss-host-path-"));
  const dirs = Object.fromEntries(DIRECTORY_KEYS.map((key) => [key, join(root, key)]));
  for (const path of Object.values(dirs)) {
    await mkdir(path);
    await chmod(path, 0o700);
  }
  const config = parseHostConfig({
    ...dirs,
    instanceId: "40000000-0000-4000-8000-000000000004",
    ownerUserId: OWNER,
    dockerSocket: join(root, "docker.sock"),
    gatewayImage: GATEWAY_IMAGE
  });
  return { config, close: () => rm(root, { recursive: true, force: true }) };
}
export { COMPUTER_IMAGE };
