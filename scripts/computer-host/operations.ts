import type {
  ComputerHostRequest,
  ComputerHostResult,
  ComputerHostReason
} from "../../apps/api/src/computer/host-contract.js";
import { ROLES } from "./config.js";
import type { ComputerDocker } from "./docker.js";
import type { HostStateStore, HostResource } from "./state.js";

/** Only an independently reviewed runtime operator may implement this launch admission port. */
export interface ComputerRuntimeAdmission {
  assertAdmitted(): Promise<void>;
}
export const unavailableAdmission: ComputerRuntimeAdmission = {
  async assertAdmitted() {
    throw new Error("Computer runtime admission unavailable");
  }
};

export class ComputerHostOperations {
  #busy = false;
  constructor(
    private readonly store: HostStateStore,
    private readonly docker: ComputerDocker,
    private readonly admission: ComputerRuntimeAdmission
  ) {}

  #result(
    reason: ComputerHostReason,
    state: ComputerHostResult["state"] = "unavailable"
  ): ComputerHostResult {
    return {
      generation: this.store.state.generation,
      enabled: this.store.state.enabled,
      state,
      reason
    };
  }
  async request(request: ComputerHostRequest): Promise<ComputerHostResult> {
    if (request.actorUserId !== this.store.config.ownerUserId) return this.#result("owner-denied");
    if (this.#busy) return this.#result("busy");
    this.#busy = true;
    try {
      await this.store.assertRoots();
      if (request.operation === "status") return await this.#status();
      if (request.expectedGeneration !== this.store.state.generation)
        return this.#result("stale-generation");
      if (this.store.state.generation === Number.MAX_SAFE_INTEGER)
        return this.#result("runtime-unavailable");
      await this.store.save({
        ...this.store.state,
        generation: this.store.state.generation + 1,
        enabled: request.operation !== "disable"
      });
      if (request.operation !== "disable") {
        try {
          if (!this.store.config.gatewayImage) return this.#result("prerequisite-unavailable");
          await this.admission.assertAdmitted();
        } catch {
          return this.#result("prerequisite-unavailable");
        }
        await this.docker.images();
      }
      // Validate the complete inventory BEFORE stopping any resource, including partial pairs.
      const resources = await this.docker.inventory(this.store.state.resources);
      await this.#remember(resources.map((entry) => entry.resource));
      if (
        request.operation === "enable" &&
        resources.length === 2 &&
        resources.every((entry) => entry.running)
      )
        return this.#result("none", "running");
      await this.#removeAll();
      if (request.operation === "disable") return this.#result("none", "disabled");
      try {
        for (const role of ROLES) {
          const intent: HostResource = { role, generation: this.store.state.generation, id: null };
          await this.#remember([...this.store.state.resources, intent]);
          const id = await this.docker.create(intent);
          const resource = { ...intent, id };
          await this.#remember(
            this.store.state.resources.map((entry) => (entry.role === role ? resource : entry))
          );
          await this.docker.start(resource);
        }
        return await this.#status();
      } catch {
        // Reconcile the persisted exact intents once. An unknown create is never retried.
        try {
          const inventory = await this.docker.inventory(this.store.state.resources);
          await this.#remember(inventory.map((entry) => entry.resource));
          await this.#removeAll();
        } catch {
          /* Retain unresolved identities for explicit recovery; never claim closure. */
        }
        return this.#result("runtime-unavailable");
      }
    } catch {
      return this.#result("runtime-unavailable");
    } finally {
      this.#busy = false;
    }
  }
  async #status(): Promise<ComputerHostResult> {
    if (!this.store.config.gatewayImage && this.store.state.resources.length !== 0)
      return this.#result("prerequisite-unavailable");
    const resources = await this.docker.inventory(this.store.state.resources);
    if (!this.store.state.enabled && resources.length === 0)
      return this.#result("none", "disabled");
    if (
      this.store.state.enabled &&
      resources.length === 2 &&
      resources.every((entry) => entry.running)
    )
      return this.#result("none", "running");
    return this.#result("prerequisite-unavailable");
  }
  async #remember(resources: readonly HostResource[]): Promise<void> {
    await this.store.save({ ...this.store.state, resources });
  }
  async #removeAll(): Promise<void> {
    for (const role of ROLES) {
      const resource = this.store.state.resources.find((entry) => entry.role === role);
      if (!resource) continue;
      await this.store.assertRoots();
      await this.docker.remove(resource);
      await this.#remember(this.store.state.resources.filter((entry) => entry.role !== role));
    }
  }
}
