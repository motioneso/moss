import type {
  ComputerHostRequest,
  ComputerHostResult
} from "../../apps/api/src/computer/host-contract.js";
import type { SupervisorOutcome } from "../computer-watchdog/supervisor.js";
import type { ComputerDocker } from "./docker.js";
import type { HostStateStore } from "./state.js";
import {
  persistComputerStop,
  reconcileComputerStop,
  type ComputerRecoveryResult,
  type StopReceipt
} from "./recovery.js";

const failure = () => new Error("Computer terminal lifecycle unavailable");

/** Existing-resource operations only. No admission port, create/start, reset or forced stop. */
export class ComputerTerminalHost {
  #checking = false;
  #intent?: Promise<StopReceipt>;
  #expiresAt = 0;
  #finishing = false;
  #cleaned = false;
  #resolve!: (value: ComputerRecoveryResult) => void;
  #reject!: (error: unknown) => void;
  readonly completed = new Promise<ComputerRecoveryResult>((resolve, reject) => {
    this.#resolve = resolve;
    this.#reject = reject;
  });

  constructor(
    readonly store: HostStateStore,
    private readonly docker: ComputerDocker,
    private readonly control: {
      stopRoot(): void;
      terminal(expiresAt: number): void;
      now(): number;
    }
  ) {
    void this.completed.catch(() => {});
  }

  /** Called by actual root terminal entry before any await; persistence cannot hold up fencing. */
  latch(): void {
    this.store.latchStop();
    if (this.#intent) return;
    this.#expiresAt = this.control.now() + 120_000;
    this.#intent = persistComputerStop(this.store);
    void this.#intent.catch(() => {});
    this.control.terminal(this.#expiresAt);
  }

  stop(): void {
    this.latch();
    this.control.stopRoot();
  }

  /** Managed composition supplies only the outcome of its own actual root invocation. */
  async finish(outcome: SupervisorOutcome | null): Promise<void> {
    if (this.#finishing) return;
    this.#finishing = true;
    this.latch();
    try {
      const receipt = await this.#intent!;
      const assertCurrent = () => {
        if (
          !outcome ||
          !outcome.receiverFenced ||
          !outcome.durableStop ||
          !outcome.collectorExited ||
          (outcome.exitCode !== 0 && outcome.exitCode !== 1) ||
          this.control.now() >= this.#expiresAt
        )
          throw failure();
      };
      assertCurrent();
      const result = await reconcileComputerStop(this.store, this.docker, receipt, assertCurrent);
      this.#cleaned = true;
      this.#resolve(result);
    } catch (error) {
      this.#reject(error);
    }
  }

  #result(
    reason: ComputerHostResult["reason"],
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
    if (this.#checking) return this.#result("busy");
    this.#checking = true;
    try {
      await this.store.assertRoots();
      if (request.operation === "status") {
        const inventory = await this.docker.inventory(this.store.state.resources);
        if (inventory.length === 0 && (!this.store.state.enabled || this.#cleaned))
          return this.#result("none", "disabled");
        if (
          !this.store.stopRequested &&
          this.store.state.enabled &&
          inventory.length === 2 &&
          inventory.every((x) => x.running)
        )
          return this.#result("none", "running");
        return this.#result("prerequisite-unavailable");
      }
      if (request.expectedGeneration !== this.store.state.generation)
        return this.#result("stale-generation");
      if (request.operation === "enable" || this.store.stopRequested)
        return this.#result("prerequisite-unavailable");
      this.stop();
      await this.completed;
      return request.operation === "disable"
        ? this.#result("none", "disabled")
        : this.#result("prerequisite-unavailable");
    } catch {
      return this.#result("runtime-unavailable");
    } finally {
      this.#checking = false;
    }
  }
}
