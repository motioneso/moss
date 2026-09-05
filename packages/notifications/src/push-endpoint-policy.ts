import dns from "node:dns";
import https from "node:https";
import net from "node:net";

import { PUSH_AUTH_PATTERN, PUSH_ENDPOINT_MAX_LENGTH, PUSH_P256DH_PATTERN } from "@moss/shared";

/**
 * Where a push delivery address may point (#743 security finding 1).
 *
 * The browser hands the client an https URL owned by a public push service. The server
 * still refuses anything that could turn a delivery attempt into a request against the
 * box or its network: non-https schemes, credentials in the URL, IP-literal hosts, and
 * hostnames that only mean something inside a private network. The same rules run again
 * at send time on the resolved address, so a public hostname that later resolves to a
 * private one (DNS rebinding) is refused as well.
 */

/** Thrown when a registration request carries an address or key the policy refuses. Routes answer 400. */
export class PushSubscriptionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushSubscriptionInvalidError";
  }
}

export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

const P256DH_REGEX = new RegExp(PUSH_P256DH_PATTERN);
const AUTH_REGEX = new RegExp(PUSH_AUTH_PATTERN);
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE_REGEX = /[\x00-\x1f\x7f\s]/;

/** Hostname suffixes that never name a public push service. Compared case-insensitively. */
const PRIVATE_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".arpa"];
const PRIVATE_HOSTS = new Set(["localhost", "localhost."]);

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * True when the hostname, as written, is an IP literal or a name reserved for private
 * networks. Public push services always use a public DNS name.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = stripBrackets(hostname.trim().toLowerCase());
  if (host.length === 0) {
    return true;
  }
  if (net.isIP(host) !== 0) {
    return true;
  }
  if (PRIVATE_HOSTS.has(host)) {
    return true;
  }
  const withoutTrailingDot = host.endsWith(".") ? host.slice(0, -1) : host;
  if (!withoutTrailingDot.includes(".")) {
    // A single label ("intranet", "router") only resolves inside a private network.
    return true;
  }
  return PRIVATE_HOST_SUFFIXES.some((suffix) => withoutTrailingDot.endsWith(suffix));
}

function ipv4ToNumber(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    value = value * 256 + octet;
  }
  return value;
}

function inRange(value: number, base: string, prefixBits: number): boolean {
  const baseValue = ipv4ToNumber(base);
  if (baseValue === null) {
    return false;
  }
  const size = 2 ** (32 - prefixBits);
  return value >= baseValue && value < baseValue + size;
}

/**
 * Non-public IPv4 space: "this network", private (RFC 1918), carrier-grade NAT, loopback,
 * link-local, IETF protocol assignments, benchmarking, multicast, reserved and broadcast.
 */
function isPrivateIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  if (value === null) {
    return true;
  }
  return (
    inRange(value, "0.0.0.0", 8) ||
    inRange(value, "10.0.0.0", 8) ||
    inRange(value, "100.64.0.0", 10) ||
    inRange(value, "127.0.0.0", 8) ||
    inRange(value, "169.254.0.0", 16) ||
    inRange(value, "172.16.0.0", 12) ||
    inRange(value, "192.0.0.0", 24) ||
    inRange(value, "192.168.0.0", 16) ||
    inRange(value, "198.18.0.0", 15) ||
    inRange(value, "224.0.0.0", 3)
  );
}

function expandIpv6Groups(address: string): number[] | null {
  const zoneless = address.split("%")[0] ?? address;
  const halves = zoneless.split("::");
  if (halves.length > 2) {
    return null;
  }
  const parse = (part: string): number[] | null => {
    if (part.length === 0) {
      return [];
    }
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (group.includes(".")) {
        // Embedded IPv4 tail, e.g. ::ffff:10.0.0.1
        const v4 = ipv4ToNumber(group);
        if (v4 === null) {
          return null;
        }
        groups.push(Math.floor(v4 / 65536), v4 % 65536);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(group)) {
        return null;
      }
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (head === null || tail === null) {
    return null;
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    return null;
  }
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * Non-public IPv6 space: unspecified, loopback, v4-mapped (checked as IPv4), unique local,
 * link-local, multicast, and the documentation, Teredo and discard prefixes.
 */
function isPrivateIpv6(address: string): boolean {
  const groups = expandIpv6Groups(address);
  if (groups === null) {
    return true;
  }
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  const leadingZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (leadingZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) {
    return true; // :: and ::1
  }
  if (leadingZero && g5 === 0xffff) {
    const v4 = `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
    return isPrivateIpv4(v4);
  }
  if ((g0 & 0xfe00) === 0xfc00) {
    return true; // fc00::/7 unique local
  }
  if ((g0 & 0xffc0) === 0xfe80) {
    return true; // fe80::/10 link-local
  }
  if ((g0 & 0xff00) === 0xff00) {
    return true; // ff00::/8 multicast
  }
  if (g0 === 0x2001 && (g1 === 0x0db8 || g1 === 0)) {
    return true; // documentation, Teredo
  }
  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) {
    return true; // 100::/64 discard
  }
  return false;
}

/** True when a resolved address must never be contacted from the box. */
export function isPrivateAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    return isPrivateIpv4(address);
  }
  if (family === 6) {
    return isPrivateIpv6(address);
  }
  return true;
}

/**
 * Parses and checks a delivery address. Returns the normalized URL string or throws
 * PushSubscriptionInvalidError with a message safe to show to the user.
 */
export function validatePushEndpoint(endpoint: string): string {
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new PushSubscriptionInvalidError("Push endpoint is required");
  }
  if (endpoint.length > PUSH_ENDPOINT_MAX_LENGTH) {
    throw new PushSubscriptionInvalidError("Push endpoint is too long");
  }
  if (CONTROL_OR_SPACE_REGEX.test(endpoint)) {
    throw new PushSubscriptionInvalidError("Push endpoint contains invalid characters");
  }
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new PushSubscriptionInvalidError("Push endpoint is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new PushSubscriptionInvalidError("Push endpoint must use https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new PushSubscriptionInvalidError("Push endpoint must not contain credentials");
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new PushSubscriptionInvalidError("Push endpoint must point at a public push service");
  }
  return parsed.toString();
}

/**
 * Checks a whole registration: the address plus both keys. The keys are fixed-size by
 * the Web Push encryption spec, so anything else is a malformed or hostile request.
 */
export function validatePushSubscriptionInput(input: PushSubscriptionInput): PushSubscriptionInput {
  const endpoint = validatePushEndpoint(input.endpoint);
  if (typeof input.p256dh !== "string" || !P256DH_REGEX.test(input.p256dh)) {
    throw new PushSubscriptionInvalidError("Push key p256dh is malformed");
  }
  if (typeof input.auth !== "string" || !AUTH_REGEX.test(input.auth)) {
    throw new PushSubscriptionInvalidError("Push key auth is malformed");
  }
  return { endpoint, p256dh: input.p256dh, auth: input.auth };
}

export type LookupFunction = typeof dns.lookup;

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: unknown,
  family?: unknown
) => void;

/**
 * Wraps a DNS lookup so a hostname that resolves to a private, loopback, link-local or
 * otherwise non-public address fails the connection instead of reaching the box's network.
 * This is the send-time half of the policy: the registration check sees only the name.
 */
export function createGuardedLookup(base: LookupFunction = dns.lookup): LookupFunction {
  const guarded = (hostname: string, optionsOrCallback: unknown, maybeCallback?: unknown): void => {
    const hasOptions = typeof optionsOrCallback !== "function";
    const options = hasOptions ? optionsOrCallback : undefined;
    const callback = (hasOptions ? maybeCallback : optionsOrCallback) as LookupCallback;

    if (isPrivateHostname(hostname)) {
      callback(refused(hostname));
      return;
    }

    const onResult: LookupCallback = (err, address, family) => {
      if (err) {
        callback(err);
        return;
      }
      const addresses = Array.isArray(address)
        ? address.map((entry: { address: string } | string) =>
            typeof entry === "string" ? entry : entry.address
          )
        : [String(address)];
      if (addresses.some((resolved) => isPrivateAddress(resolved))) {
        callback(refused(hostname));
        return;
      }
      callback(null, address, family);
    };

    if (options === undefined) {
      base(hostname, onResult as never);
    } else {
      base(hostname, options as never, onResult as never);
    }
  };

  return guarded as unknown as LookupFunction;
}

function refused(hostname: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `Push endpoint host ${hostname} resolves to a non-public address`
  );
  error.code = "EPUSHPRIVATEADDRESS";
  return error;
}

/** Socket timeout for one push send, in milliseconds. */
export const PUSH_SEND_TIMEOUT_MS = 10_000;

/** The https agent every push send goes through: guarded DNS, bounded connect time. */
export function createPushHttpsAgent(lookup: LookupFunction = createGuardedLookup()): https.Agent {
  return new https.Agent({ lookup, timeout: PUSH_SEND_TIMEOUT_MS, keepAlive: false });
}
