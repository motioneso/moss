import type { Socket } from "node:net";
import { LifetimeChannel } from "./lifetime-channel.js";
import {
  lifetimeHeader,
  lifetimeNonce,
  lifetimeNow,
  lifetimeError,
  parseComputerLifetime,
  sameChallenge,
  signLifetime,
  verifyLifetime,
  type ComputerLifetimeConfiguration,
  type LifetimeProof
} from "./lifetime-protocol.js";

/** One irreversible receiver lifetime. Retirement is synchronous; cleanup is owned by the gateway. */
export class ComputerLifetimeReceiver {
  #channel: LifetimeChannel;
  #phase: "header" | "response" | "idle" | "fencing" | "closed" = "header";
  #deadline: number;
  #timer?: ReturnType<typeof setTimeout>;
  #rootNonce = "";
  #sessionNonce = lifetimeNonce();
  #challenge?: LifetimeProof;
  #challengeAt = 0;
  #counter = 0;
  readonly #config: ComputerLifetimeConfiguration;
  constructor(
    socket: Socket,
    config: ComputerLifetimeConfiguration,
    readonly activated: () => void,
    readonly retire: () => void,
    readonly now = lifetimeNow
  ) {
    this.#config = parseComputerLifetime(config);
    this.#deadline = now() + 2000;
    this.#channel = new LifetimeChannel(
      socket,
      (value) => this.#receive(value),
      () => this.close(),
      now
    );
    this.#timer = setTimeout(() => this.close(), 2000);
  }
  #receive(value: unknown) {
    if (this.#phase === "closed" || this.#phase === "fencing" || this.now() >= this.#deadline)
      throw lifetimeError();
    if (this.#phase === "header") {
      if (!lifetimeHeader(value)) throw lifetimeError();
      this.#rootNonce = value.rootNonce;
      this.#issue();
      return;
    }
    const proof = verifyLifetime(this.#config, value);
    if (proof.rootNonce !== this.#rootNonce || proof.sessionNonce !== this.#sessionNonce)
      throw lifetimeError();
    if (proof.type === "stop") {
      this.#phase = "fencing";
      clearTimeout(this.#timer);
      this.#deadline = this.now() + 2000;
      this.#timer = setTimeout(() => this.close(), 2000);
      this.retire(); // Must invoke core.close/epoch retirement before signing the acknowledgement.
      this.#channel.send(signLifetime(this.#config, { ...proof, type: "fenced" }), () =>
        this.close()
      );
      return;
    }
    if (
      this.#phase !== "response" ||
      proof.type !== "alive" ||
      !this.#challenge ||
      !sameChallenge(proof, this.#challenge)
    )
      throw lifetimeError();
    this.#phase = "idle";
    clearTimeout(this.#timer);
    this.#deadline = this.#challengeAt + 2000;
    this.#channel.send(signLifetime(this.#config, { ...proof, type: "active" }));
    this.activated();
    this.#timer = setTimeout(
      () => {
        try {
          this.#issue();
        } catch {
          this.close();
        }
      },
      Math.max(0, this.#challengeAt + 1000 - this.now())
    );
  }
  #issue() {
    if (this.now() >= this.#deadline || ++this.#counter > 4096) throw lifetimeError();
    clearTimeout(this.#timer);
    this.#phase = "response";
    this.#challengeAt = this.now();
    this.#deadline = this.#challengeAt + 1000;
    this.#challenge = {
      type: "challenge",
      version: 1,
      rootNonce: this.#rootNonce,
      sessionNonce: this.#sessionNonce,
      challengeNonce: lifetimeNonce(),
      counter: this.#counter
    };
    this.#timer = setTimeout(() => this.close(), 1000);
    this.#channel.send(signLifetime(this.#config, this.#challenge));
  }
  assertActive() {
    if (
      (this.#phase !== "idle" && this.#phase !== "response") ||
      this.#counter === 0 ||
      this.now() >= this.#deadline
    ) {
      this.close();
      throw lifetimeError();
    }
  }
  close() {
    if (this.#phase === "closed") return;
    this.#phase = "closed";
    clearTimeout(this.#timer);
    this.retire();
    this.#channel.close();
  }
}
