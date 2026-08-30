import { isIP } from "node:net";

/**
 * Shared with @moss/auth (#1505): both the API server's XFF/HSTS trust decision and
 * the auth package's secure-cookie decision must agree on what "TLS is in front of
 * us" means, so the parsing rules live in one place rather than being duplicated.
 */
const TRUST_PROXY_ERROR =
  'JARVIS_TRUST_PROXY must be unset, "loopback", or a comma-separated list of exact IP addresses';

export function resolveTrustProxy(value: string | undefined): false | string | string[] {
  const normalized = value?.trim() ?? "";
  if (!normalized) return false;
  if (normalized.toLowerCase() === "loopback") return "loopback";

  const addresses = normalized.split(",").map((address) => address.trim());
  if (addresses.some((address) => !address || isIP(address) === 0)) {
    throw new Error(TRUST_PROXY_ERROR);
  }

  return addresses.length === 1 ? addresses[0]! : addresses;
}
