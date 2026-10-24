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
}

/** Host-only Docker client. No exec, arbitrary command, image pull or API import/caller. */
export class ComputerDocker {
  constructor(private readonly config: HostConfig) {}
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
    const identity = resource.id ?? resourceName(this.config, resource);
    const reply = await this.#call("GET", `/containers/${identity}/json`);
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
    return { resource: { ...resource, id: reply.Id }, running: reply.State.Running };
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
      inspected.push(await this.inspect(resource));
    }
    const ids = new Set(inspected.map((entry) => entry.resource.id));
    if (ids.size !== reply.length || reply.some((row) => !ids.has(row.Id)))
      throw new Error("Untracked Computer container");
    return inspected;
  }
  async create(resource: HostResource): Promise<string> {
    const reply = await this.#call(
      "POST",
      `/containers/create?name=${resourceName(this.config, resource)}`,
      resourceSpec(this.config, resource)
    );
    if (!isRecord(reply) || !fullDockerId(reply.Id))
      throw new Error("Unknown Computer create result");
    return reply.Id;
  }
  async start(resource: HostResource): Promise<void> {
    const { resource: verified } = await this.inspect(resource);
    await this.#call("POST", `/containers/${verified.id}/start`);
  }
  async remove(resource: HostResource): Promise<void> {
    let verified = await this.inspect(resource);
    if (verified.running) {
      try {
        await this.#call("POST", `/containers/${verified.resource.id}/stop?t=10`);
      } catch (error) {
        // A timeout has unknown outcome. Reinspect the same full ID before an emergency kill.
        verified = await this.inspect(verified.resource);
        if (verified.running)
          await this.#call("POST", `/containers/${verified.resource.id}/kill?signal=SIGKILL`);
        if (error instanceof HostHttpError && error.status === 404) throw error;
      }
    }
    verified = await this.inspect(verified.resource);
    if (verified.running) throw new Error("Computer failed to stop");
    // Never force-remove a running resource, and never remove volumes.
    await this.#call("DELETE", `/containers/${verified.resource.id}?force=0&v=0`);
  }
}
