import { createConnection } from "node:net";
import { LifetimeChannel } from "../../apps/api/src/computer/lifetime-channel.js";
import {
  lifetimeError,
  lifetimeNonce,
  parseComputerLifetime,
  sameChallenge,
  signLifetime,
  verifyLifetime,
  type ComputerLifetimeConfiguration,
  type LifetimeProof
} from "../../apps/api/src/computer/lifetime-protocol.js";

/** Root publisher. Traffic checks policy but never supplies a heartbeat or a fresh sample. */
export class ComputerRootLifetime {
  #phase: "new" | "connecting" | "challenge" | "active" | "stopping" | "closed" = "new";
  #channel?: LifetimeChannel;
  #deadline = 0;
  #timer?: ReturnType<typeof setTimeout>;
  #rootNonce = lifetimeNonce();
  #sessionNonce = "";
  #counter = 0;
  #outstanding?: LifetimeProof;
  #stopNonce = "";
  #resolveStop?: (fenced: boolean) => void;
  #stopResult?: Promise<boolean>;
  readonly #config: ComputerLifetimeConfiguration;
  constructor(
    readonly input: {
      configuration: ComputerLifetimeConfiguration;
      socketPath: string;
      healthy(): boolean;
      failed(): void;
      activated?(): void;
      now(): number;
    }
  ) {
    this.#config = parseComputerLifetime(input.configuration);
  }
  start() {
    if (this.#phase !== "new") throw lifetimeError();
    if (!this.input.healthy()) {
      this.#fail();
      return;
    }
    this.#phase = "connecting";
    this.#arm();
    const socket = createConnection({ path: this.input.socketPath });
    this.#channel = new LifetimeChannel(
      socket,
      (value) => this.#receive(value),
      () => this.#fail(),
      this.input.now
    );
    socket.once("connect", () => {
      try {
        if (
          this.#phase !== "connecting" ||
          this.input.now() >= this.#deadline ||
          !this.input.healthy()
        )
          throw lifetimeError();
        this.#phase = "challenge";
        this.#arm();
        this.#channel!.send({ type: "hello", version: 1, rootNonce: this.#rootNonce });
      } catch {
        this.#fail();
      }
    });
  }
  #arm() {
    clearTimeout(this.#timer);
    this.#deadline = this.input.now() + 2000;
    this.#timer = setTimeout(() => this.#fail(), 2000);
  }
  #receive(value: unknown) {
    if (this.input.now() >= this.#deadline) throw lifetimeError();
    const proof = verifyLifetime(this.#config, value);
    if (
      proof.rootNonce !== this.#rootNonce ||
      (this.#sessionNonce && proof.sessionNonce !== this.#sessionNonce)
    )
      throw lifetimeError();
    if (this.#phase === "stopping") {
      // A response already written before terminal entry may have its ack in flight.
      if (proof.type === "active" && this.#outstanding && sameChallenge(proof, this.#outstanding)) {
        this.#outstanding = undefined;
        return;
      }
      // A next challenge may have crossed the stop. It never receives another alive response.
      if (
        proof.type === "challenge" &&
        "counter" in proof &&
        proof.counter === this.#counter + 1 &&
        !this.#outstanding
      ) {
        this.#counter++;
        return;
      }
      if (proof.type !== "fenced" || !("stopNonce" in proof) || proof.stopNonce !== this.#stopNonce)
        throw lifetimeError();
      this.#finish(true);
      return;
    }
    if (
      this.#phase === "challenge" &&
      proof.type === "challenge" &&
      "counter" in proof &&
      proof.counter === this.#counter + 1 &&
      this.input.healthy()
    ) {
      this.#sessionNonce = proof.sessionNonce;
      this.#counter = proof.counter;
      this.#outstanding = proof;
      this.#phase = "active";
      this.#arm();
      this.#channel!.send(signLifetime(this.#config, { ...proof, type: "alive" }));
      return;
    }
    if (
      this.#phase === "active" &&
      proof.type === "active" &&
      this.#outstanding &&
      sameChallenge(proof, this.#outstanding) &&
      this.input.healthy()
    ) {
      this.#outstanding = undefined;
      this.#phase = "challenge";
      this.#arm();
      if (this.#counter === 1) this.input.activated?.();
      return;
    }
    throw lifetimeError();
  }
  stop(): Promise<boolean> {
    if (this.#stopResult) return this.#stopResult;
    const prior = this.#phase;
    this.#phase = "stopping"; // Irreversible latch before writes or promises.
    this.#stopResult = new Promise<boolean>((resolve) => {
      this.#resolveStop = resolve;
    });
    if (!this.#sessionNonce || prior === "closed" || !this.#channel) {
      this.#finish(false);
    } else {
      this.#stopNonce = lifetimeNonce();
      this.#arm();
      try {
        this.#channel.send(
          signLifetime(this.#config, {
            type: "stop",
            version: 1,
            rootNonce: this.#rootNonce,
            sessionNonce: this.#sessionNonce,
            stopNonce: this.#stopNonce
          })
        );
      } catch {
        this.#finish(false);
      }
    }
    return this.#stopResult;
  }
  #finish(fenced: boolean) {
    this.#phase = "closed";
    clearTimeout(this.#timer);
    this.#channel?.close();
    this.#resolveStop?.(fenced);
  }
  #fail() {
    if (this.#phase === "closed") return;
    const stopping = this.#phase === "stopping";
    this.#finish(false);
    if (!stopping) this.input.failed();
  }
}
