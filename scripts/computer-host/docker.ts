import { HostHttpError, hostJsonRequest } from "../../apps/api/src/computer/host-http.js";
import { isRecord } from "../../apps/api/src/computer/host-contract.js";
import { COMPUTER_IMAGE, type HostConfig } from "./config.js";
import { fullDockerId, type HostResource } from "./state.js";
import { resourceLabels, resourceName, resourceSpec } from "./spec.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function equal(actual: unknown, expected: unknown): boolean {
  // Docker normalizes absent empty collections to null in inspected defaults.
  if (
    actual === null &&
    (Array.isArray(expected)
      ? expected.length === 0
      : isRecord(expected) && Object.keys(expected).length === 0)
  )
    return true;
  return canonical(actual) === canonical(expected);
}
export interface InspectedResource {
  readonly resource: HostResource & { id: string };
  readonly running: boolean;
  readonly logPath: string | null;
}

class KnownContainerAbsent extends Error {}

export interface ComputerMutationGuard {
  check(): Promise<void>;
  assertCurrent(): void;
}

/** Host-only Docker client. No exec, arbitrary command, image pull or API import/caller. */
export class ComputerDocker {
  constructor(private readonly config: HostConfig) {}
  async #mutate(
    method: "POST" | "DELETE",
    path: string,
    guard: ComputerMutationGuard | undefined,
    body?: unknown
  ): Promise<unknown> {
    if (guard) {
      await guard.check();
      guard.assertCurrent();
    }
    return this.#call(method, path, body);
  }
  #call(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<unknown> {
    return hostJsonRequest({
      socketPath: this.config.dockerSocket,
      method,
      path: `/v1.47${path}`,
      body,
      limit: 256 * 1024,
      timeoutMs: 15_000
    });
  }
  async #image(image: string): Promise<Record<string, unknown>> {
    const reply = await this.#call("GET", `/images/${encodeURIComponent(image)}/json`);
    if (!isRecord(reply) || reply.Id !== image || !isRecord(reply.Config))
      throw new Error("Pinned image unavailable");
    return reply.Config;
  }
  async images(): Promise<void> {
    if (!this.config.gatewayImage) throw new Error("Gateway image unavailable");
    await this.#image(COMPUTER_IMAGE);
    await this.#image(this.config.gatewayImage);
  }
  async inspect(resource: HostResource): Promise<InspectedResource> {
    return this.#inspect(resource, false);
  }
  async #inspect(resource: HostResource, created: boolean): Promise<InspectedResource> {
    const identity = resource.id ?? resourceName(this.config, resource);
    const reply = await this.#call("GET", `/containers/${identity}/json`).catch(
      (error: unknown) => {
        if (resource.id !== null && error instanceof HostHttpError && error.status === 404)
          throw new KnownContainerAbsent("Recorded immutable Computer container is absent");
        throw error;
      }
    );
    const expected = resourceSpec(this.config, resource);
    if (
      !isRecord(reply) ||
      !fullDockerId(reply.Id) ||
      (resource.id !== null && reply.Id !== resource.id) ||
      reply.Name !== `/${resourceName(this.config, resource)}` ||
      reply.Image !== expected.Image ||
      !isRecord(reply.Config) ||
      !isRecord(reply.HostConfig) ||
      !isRecord(reply.State) ||
      typeof reply.State.Running !== "boolean" ||
      reply.Config.Image !== expected.Image ||
      reply.Config.User !== expected.User ||
      !equal(reply.Config.Labels, resourceLabels(this.config, resource)) ||
      reply.Config.Tty !== false ||
      reply.Config.OpenStdin !== false
    )
      throw new Error("Computer container identity mismatch");
    if (
      created &&
      (reply.State.Running ||
        reply.State.Status !== "created" ||
        reply.State.Pid !== 0 ||
        typeof reply.State.StartedAt !== "string" ||
        !/^0001-01-01T00:00:00(?:\.0{1,9})?Z$/.test(reply.State.StartedAt))
    )
      throw new Error("Computer container was already started");
    for (const [key, value] of Object.entries(expected.HostConfig)) {
      if (!equal(reply.HostConfig[key], value))
        throw new Error("Computer runtime configuration mismatch");
    }
    // Bind mounts are the complete writable/data interface. Reject extra mounts and published ports.
    if (
      !Array.isArray(reply.Mounts) ||
      reply.Mounts.length !== expected.HostConfig.Binds.length ||
      !isRecord(reply.NetworkSettings) ||
      !equal(reply.NetworkSettings.Ports, {})
    )
      throw new Error("Unexpected Computer mounts or ports");
    for (const bind of expected.HostConfig.Binds) {
      const [source, destination, mode] = bind.split(":");
      if (
        !reply.Mounts.some(
          (mount: unknown) =>
            isRecord(mount) &&
            mount.Type === "bind" &&
            mount.Source === source &&
            mount.Destination === destination &&
            mount.RW === (mode === "rw") &&
            mount.Propagation === "rprivate"
        )
      )
        throw new Error("Computer mount mismatch");
    }
    const defaults = await this.#image(expected.Image);
    for (const key of ["Cmd", "Entrypoint", "Env", "WorkingDir", "Healthcheck"]) {
      if (!equal(reply.Config[key], defaults[key]))
        throw new Error("Computer image defaults changed");
    }
    return {
      resource: { ...resource, id: reply.Id },
      running: reply.State.Running,
      logPath: typeof reply.LogPath === "string" ? reply.LogPath : null
    };
  }
  async inventory(resources: readonly HostResource[]): Promise<InspectedResource[]> {
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`com.moss.computer.instance=${this.config.instanceId}`] })
    );
    const reply = await this.#call("GET", `/containers/json?all=1&filters=${filters}`);
    if (
      !Array.isArray(reply) ||
      reply.length > 2 ||
      !reply.every((row: unknown) => isRecord(row) && fullDockerId(row.Id))
    )
      throw new Error("Ambiguous Computer inventory");
    const inspected = [];
    for (const resource of resources) {
      // A pending intent with no observed container is deliberately unresolved: a cancelled create
      // can still complete in Docker. Never clear it or claim closure from a single 404/list miss.
      try {
        inspected.push(await this.inspect(resource));
      } catch (error) {
        // Only the exact known-ID container inspect404 proves absence. Image/spec failures and
        // pending-name404 remain unavailable; they cannot erase durable cleanup identities.
        if (!(error instanceof KnownContainerAbsent)) throw error;
      }
    }
    const ids = new Set(inspected.map((entry) => entry.resource.id));
    if (ids.size !== reply.length || reply.some((row) => !ids.has(row.Id)))
      throw new Error("Untracked Computer container");
    return inspected;
  }
  /** Read-only exact pair check; running=false alone cannot qualify a new configuration. */
  async createdPair(resources: readonly HostResource[]): Promise<void> {
    if (
      resources.length !== 2 ||
      new Set(resources.map((r) => r.role)).size !== 2 ||
      resources.some((r) => !fullDockerId(r.id)) ||
      new Set(resources.map((r) => r.id)).size !== 2 ||
      (await this.inventory(resources)).length !== 2
    )
      throw new Error("Exact created Computer pair required");
    for (const resource of resources) await this.#inspect(resource, true);
  }
  async create(resource: HostResource, guard: ComputerMutationGuard): Promise<string> {
    if (!guard) throw new Error("Computer launch guard required");
    const reply = await this.#mutate(
      "POST",
      `/containers/create?name=${resourceName(this.config, resource)}`,
      guard,
      resourceSpec(this.config, resource)
    );
    if (!isRecord(reply) || !fullDockerId(reply.Id))
      throw new Error("Unknown Computer create result");
    return reply.Id;
  }
  async start(resource: HostResource, guard: ComputerMutationGuard): Promise<void> {
    if (!guard) throw new Error("Computer launch guard required");
    const { resource: verified } = await this.inspect(resource);
    await this.#mutate("POST", `/containers/${verified.id}/start`, guard);
  }
  async remove(resource: HostResource, guard?: ComputerMutationGuard): Promise<void> {
    let verified = await this.inspect(resource);
    if (verified.running) {
      try {
        await this.#mutate("POST", `/containers/${verified.resource.id}/stop?t=10`, guard);
      } catch (error) {
        // A timeout has unknown outcome. Reinspect the same full ID before an emergency kill.
        verified = await this.inspect(verified.resource);
        if (verified.running) {
          await this.#mutate(
            "POST",
            `/containers/${verified.resource.id}/kill?signal=SIGKILL`,
            guard
          );
        }
        if (error instanceof HostHttpError && error.status === 404) throw error;
      }
    }
    verified = await this.inspect(verified.resource);
    if (verified.running) throw new Error("Computer failed to stop");
    // Never force-remove a running resource, and never remove volumes.
    await this.#mutate("DELETE", `/containers/${verified.resource.id}?force=0&v=0`, guard);
  }
}
