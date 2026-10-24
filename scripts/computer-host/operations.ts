import type {
  ComputerHostRequest,
  ComputerHostResult,
  ComputerHostReason
} from "../../apps/api/src/computer/host-contract.js";
import { ROLES } from "./config.js";
import type { ComputerDocker, ComputerMutationGuard } from "./docker.js";
import { TerminalStateConflict, type HostStateStore, type HostResource } from "./state.js";

/** Only an independently reviewed runtime operator may implement this launch admission port. */
export interface ComputerRuntimeAdmission {
  assertAdmitted(): Promise<void>;
  /** Synchronously closes future receiving admission; implementations must not throw. */
  invalidate(): void;
}
export const unavailableAdmission: ComputerRuntimeAdmission = {
  invalidate() {},
  async assertAdmitted() {
    throw new Error("Computer runtime admission unavailable");
  }
};

export class ComputerHostOperations {
  #busy = false;
  #admissionBroken = false;
  readonly #launchGuard: ComputerMutationGuard;
  constructor(
    private readonly store: HostStateStore,
    private readonly docker: ComputerDocker,
    private readonly admission: ComputerRuntimeAdmission
  ) {
    this.#launchGuard = {
      check: () => this.store.assertLaunchable(),
      assertCurrent: () => this.store.assertNotStopped()
    };
  }

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
      try {
        await this.store.assertLaunchable();
      } catch {
        this.#invalidateAdmission();
        return this.#result("prerequisite-unavailable");
      }
      if (this.store.state.generation === Number.MAX_SAFE_INTEGER)
        return this.#result("runtime-unavailable");
      await this.store.save({
        ...this.store.state,
        generation: this.store.state.generation + 1,
        enabled: request.operation !== "disable"
      });
      if (request.operation !== "disable") {
        try {
          if (!this.store.config.gatewayImage || this.#admissionBroken)
            throw new Error("Computer runtime prerequisites unavailable");
          await this.admission.assertAdmitted();
          await this.store.assertLaunchable();
        } catch {
          this.#invalidateAdmission();
          return this.#result("prerequisite-unavailable");
        }
        await this.docker.images();
      } else {
        this.#invalidateAdmission();
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
          const id = await this.docker.create(intent, this.#launchGuard);
          const resource = { ...intent, id };
          await this.#remember(
            this.store.state.resources.map((entry) => (entry.role === role ? resource : entry))
          );
          await this.docker.start(resource, this.#launchGuard);
        }
        const result = await this.#status();
        if (result.state !== "running") throw new Error("Computer pair failed startup");
        return result;
      } catch {
        this.#invalidateAdmission();
        // Reconcile the persisted exact intents once. An unknown create is never retried.
        try {
          await this.store.assertLaunchable();
          const inventory = await this.docker.inventory(this.store.state.resources);
          await this.#remember(inventory.map((entry) => entry.resource));
          await this.#removeAll();
        } catch {
          /* Retain unresolved identities for explicit recovery; never claim closure. */
        }
        return this.#result("runtime-unavailable");
      }
    } catch {
      this.#invalidateAdmission();
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
    try {
      await this.store.save({
        ...this.store.state,
        enabled: this.store.stopRequested ? false : this.store.state.enabled,
        resources
      });
    } catch (error) {
      if (!(error instanceof TerminalStateConflict)) throw error;
      // A late create result must survive terminal entry during the save's asynchronous I/O.
      // The store still rejects erasure/replacement; only a compatible disabled save can commit.
      await this.store.save({ ...this.store.state, enabled: false, resources });
    }
  }
  #invalidateAdmission(): void {
    try {
      this.admission.invalidate();
    } catch {
      this.#admissionBroken = true;
    }
  }
  async #removeAll(): Promise<void> {
    let failed = false;
    for (const role of ROLES) {
      const resource = this.store.state.resources.find((entry) => entry.role === role);
      if (!resource) continue;
      try {
        await this.store.assertRoots();
        await this.docker.remove(resource, this.#launchGuard);
        await this.#remember(this.store.state.resources.filter((entry) => entry.role !== role));
      } catch {
        failed = true;
      }
    }
    if (failed) throw new Error("Computer cleanup incomplete");
  }
}
