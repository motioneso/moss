import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { gatewayFields, isUuid } from "./host-contract.js";

export const lifetimeError = () => new Error("Computer lifetime unavailable");
export const lifetimeNow = () => Number(process.hrtime.bigint() / 1_000_000n);
export const lifetimeNonce = () => randomBytes(16).toString("hex");
export const lifetimePath = (socketPath: string) => join(dirname(socketPath), "lifetime.sock");
export interface ComputerLifetimeBinding {
  readonly runId: string;
  readonly instanceId: string;
  readonly requestGeneration: number;
  readonly desktopId: string;
  readonly desktopGeneration: number;
  readonly gatewayId: string;
  readonly gatewayGeneration: number;
}
export interface ComputerLifetimeConfiguration {
  readonly binding: ComputerLifetimeBinding;
  readonly secret: string;
}
export function parseComputerLifetime(value: unknown): ComputerLifetimeConfiguration {
  if (!gatewayFields(value, "binding,secret")) throw lifetimeError();
  const b = value.binding;
  if (
    !gatewayFields(
      b,
      "desktopGeneration,desktopId,gatewayGeneration,gatewayId,instanceId,requestGeneration,runId"
    ) ||
    !isUuid(b.runId) ||
    !isUuid(b.instanceId) ||
    ![b.requestGeneration, b.desktopGeneration, b.gatewayGeneration].every(
      (n) => typeof n === "number" && Number.isSafeInteger(n) && n > 0
    ) ||
    (b.desktopGeneration as number) > (b.requestGeneration as number) ||
    (b.gatewayGeneration as number) > (b.requestGeneration as number) ||
    ![b.desktopId, b.gatewayId, value.secret].every(
      (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s)
    ) ||
    b.desktopId === b.gatewayId
  )
    throw lifetimeError();
  return Object.freeze({
    binding: Object.freeze({
      runId: b.runId,
      instanceId: b.instanceId,
      requestGeneration: b.requestGeneration as number,
      desktopId: b.desktopId as string,
      desktopGeneration: b.desktopGeneration as number,
      gatewayId: b.gatewayId as string,
      gatewayGeneration: b.gatewayGeneration as number
    }),
    secret: value.secret as string
  });
}
type Challenge = {
  readonly type: "challenge" | "alive" | "active";
  readonly version: 1;
  readonly rootNonce: string;
  readonly sessionNonce: string;
  readonly challengeNonce: string;
  readonly counter: number;
};
type Stop = {
  readonly type: "stop" | "fenced";
  readonly version: 1;
  readonly rootNonce: string;
  readonly sessionNonce: string;
  readonly stopNonce: string;
};
export type LifetimeProof = Challenge | Stop;
export type SignedLifetimeProof = LifetimeProof & { readonly mac: string };
export function lifetimeHeader(value: unknown): value is {
  type: "hello";
  version: 1;
  rootNonce: string;
} {
  return (
    gatewayFields(value, "rootNonce,type,version") &&
    value.type === "hello" &&
    value.version === 1 &&
    nonce(value.rootNonce)
  );
}
function nonce(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}
function mac(config: ComputerLifetimeConfiguration, proof: LifetimeProof): Buffer {
  const b = config.binding;
  const fields = "counter" in proof ? [proof.counter, proof.challengeNonce] : [proof.stopNonce];
  return createHmac("sha256", Buffer.from(config.secret, "hex"))
    .update(
      JSON.stringify([
        "moss-computer-lifetime",
        proof.version,
        proof.type,
        b.runId,
        b.instanceId,
        b.requestGeneration,
        b.desktopId,
        b.desktopGeneration,
        b.gatewayId,
        b.gatewayGeneration,
        proof.rootNonce,
        proof.sessionNonce,
        ...fields
      ])
    )
    .digest();
}
export function signLifetime(
  config: ComputerLifetimeConfiguration,
  proof: LifetimeProof
): SignedLifetimeProof {
  return { ...proof, mac: mac(config, proof).toString("hex") };
}
export function verifyLifetime(
  config: ComputerLifetimeConfiguration,
  value: unknown
): SignedLifetimeProof {
  if (
    !gatewayFields(value, "challengeNonce,counter,mac,rootNonce,sessionNonce,type,version") &&
    !gatewayFields(value, "mac,rootNonce,sessionNonce,stopNonce,type,version")
  )
    throw lifetimeError();
  if (
    value.version !== 1 ||
    !nonce(value.rootNonce) ||
    !nonce(value.sessionNonce) ||
    typeof value.mac !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.mac)
  )
    throw lifetimeError();
  if ("counter" in value) {
    if (
      !["challenge", "alive", "active"].includes(String(value.type)) ||
      !Number.isSafeInteger(value.counter) ||
      (value.counter as number) < 1 ||
      (value.counter as number) > 4096 ||
      !nonce(value.challengeNonce)
    )
      throw lifetimeError();
  } else if (!["stop", "fenced"].includes(String(value.type)) || !nonce(value.stopNonce))
    throw lifetimeError();
  const proof = value as unknown as SignedLifetimeProof;
  if (!timingSafeEqual(mac(config, proof), Buffer.from(proof.mac, "hex"))) throw lifetimeError();
  return proof;
}
export function sameChallenge(a: LifetimeProof, b: LifetimeProof): boolean {
  return (
    "counter" in a &&
    "counter" in b &&
    a.rootNonce === b.rootNonce &&
    a.sessionNonce === b.sessionNonce &&
    a.counter === b.counter &&
    a.challengeNonce === b.challengeNonce
  );
}
