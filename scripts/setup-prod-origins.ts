import { isIPv4 } from "node:net";

// Pure helper for deriving the better-auth trusted origins written into the prod env file.
// Extracted from setup-prod.ts so it is unit-testable WITHOUT triggering that script's
// eager secret generation + file write (importing setup-prod.ts runs it). See #379: a real
// deploy is reached over LAN / tailnet / domain, NOT localhost, so the trusted-origins list
// must include the deploy host or better-auth rejects signup with "Invalid origin".
//
// #1505: also holds the TLS host/issuer validation and Caddy proxy IP derivation, so the
// no-lockout guarantee (a requested HTTPS origin is provably part of the trusted list, or setup
// refuses to write the file) lives next to the origins logic it depends on.

/** Thrown for any invalid TLS host, issuer, subnet, or trusted-origin override. */
export class TlsConfigError extends Error {}

export type TlsIssuer = "internal" | "acme";

export interface TlsSettings {
  /** The validated host, exactly as the operator supplied it (trimmed). */
  readonly host: string;
  readonly issuer: TlsIssuer;
  /** `https://<host>` — no port, no path, no trailing slash. */
  readonly httpsOrigin: string;
  /** The exact static Caddy IPv4 address on the compose network. */
  readonly trustProxyIp: string;
}

export interface ResolveTlsSettingsInput {
  readonly host: string | undefined;
  readonly issuer: string | undefined;
  /** JARVIS_DOCKER_SUBNET, defaulted by the caller. */
  readonly dockerSubnet: string;
}

// DNS label allowlist: only A-Za-z0-9 and '-', 1-63 chars, no leading/trailing '-'. Anchored so
// no separator (whitespace, comma, semicolon, newline) can smuggle a second token past it.
const DNS_LABEL = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function isValidDnsHost(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split(".");
  return labels.every((label) => DNS_LABEL.test(label));
}

/**
 * Validate an operator-supplied TLS host: an IPv4 literal (only with issuer "internal"), or a
 * DNS name made entirely of valid labels. Rejects everything else — scheme, userinfo, port,
 * path, query, fragment, wildcard, whitespace, IPv6, Caddyfile placeholders/metacharacters —
 * as a side effect of the allowlist rather than as a list of special cases (D2).
 */
function validateTlsHost(host: string, issuer: TlsIssuer): void {
  if (isIPv4(host)) {
    if (issuer !== "internal") {
      throw new TlsConfigError(
        `JARVIS_TLS_HOST "${host}" is an IPv4 address, which only works with JARVIS_TLS_ISSUER=internal ` +
          "(a public ACME CA cannot issue a certificate for a reserved/private address)."
      );
    }
    return;
  }

  if (isValidDnsHost(host)) return;

  if (/[\s,;]/.test(host)) {
    throw new TlsConfigError(
      `JARVIS_TLS_HOST "${host}" must be a single hostname or IPv4 address — no whitespace, comma, or semicolon.`
    );
  }
  if (host.includes("[") || host.includes(":")) {
    throw new TlsConfigError(
      `JARVIS_TLS_HOST "${host}" looks like an IPv6 address — only IPv4 and DNS hostnames are supported.`
    );
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    throw new TlsConfigError(
      `JARVIS_TLS_HOST "${host}" must not include a scheme (http:// or https://) — host only.`
    );
  }
  if (host.includes("@")) {
    throw new TlsConfigError(`JARVIS_TLS_HOST "${host}" must not include userinfo (an "@").`);
  }
  if (host.includes("/") || host.includes("?") || host.includes("#")) {
    throw new TlsConfigError(
      `JARVIS_TLS_HOST "${host}" must be a bare hostname — no path, query, or fragment.`
    );
  }
  if (host.includes("*")) {
    throw new TlsConfigError(`JARVIS_TLS_HOST "${host}" must not be a wildcard.`);
  }
  if (/[${}|]/.test(host)) {
    throw new TlsConfigError(
      `JARVIS_TLS_HOST "${host}" contains a Caddyfile placeholder or metacharacter ($, {, }, |).`
    );
  }
  throw new TlsConfigError(
    `JARVIS_TLS_HOST "${host}" is not a valid hostname or IPv4 address (labels must be 1-63 chars, ` +
      "A-Z/a-z/0-9/hyphen only, no leading/trailing hyphen, 253 chars max)."
  );
}

function resolveTlsIssuer(value: string | undefined): TlsIssuer {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "internal";
  if (trimmed === "internal" || trimmed === "acme") return trimmed;
  throw new TlsConfigError(
    `JARVIS_TLS_ISSUER "${value}" must be exactly "internal" or "acme" (unset/blank defaults to "internal").`
  );
}

/**
 * Returns undefined when no TLS host was requested (unset or blank) — the unchanged
 * no-TLS path. Otherwise validates everything and returns the settings, or throws
 * TlsConfigError with an actionable message.
 */
export function resolveTlsSettings(input: ResolveTlsSettingsInput): TlsSettings | undefined {
  const host = input.host?.trim() ?? "";
  if (!host) return undefined;

  const issuer = resolveTlsIssuer(input.issuer);
  validateTlsHost(host, issuer);

  return {
    host,
    issuer,
    httpsOrigin: `https://${host}`,
    trustProxyIp: deriveCaddyProxyIp(input.dockerSubnet)
  };
}

/** Last usable IPv4 address of an IPv4 CIDR. Throws TlsConfigError on anything else (D5). */
export function deriveCaddyProxyIp(dockerSubnet: string): string {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(dockerSubnet.trim());
  if (!match) {
    throw new TlsConfigError(
      `JARVIS_DOCKER_SUBNET "${dockerSubnet}" must be an IPv4 CIDR (e.g. 10.251.0.0/24).`
    );
  }
  const octets = [match[1]!, match[2]!, match[3]!, match[4]!].map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix < 0 || prefix > 32) {
    throw new TlsConfigError(`JARVIS_DOCKER_SUBNET "${dockerSubnet}" is not a valid IPv4 CIDR.`);
  }
  if (prefix > 30) {
    throw new TlsConfigError(
      `JARVIS_DOCKER_SUBNET "${dockerSubnet}" is too narrow (/${prefix}) to reserve a Caddy address; use /30 or wider.`
    );
  }

  const base = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const broadcast = (base | (0xffffffff >>> prefix)) >>> 0;
  const lastUsable = (broadcast - 1) >>> 0;

  return [
    (lastUsable >>> 24) & 0xff,
    (lastUsable >>> 16) & 0xff,
    (lastUsable >>> 8) & 0xff,
    lastUsable & 0xff
  ].join(".");
}

export interface DeriveTrustedOriginsInput {
  /** The chosen web port (JARVIS_WEB_PORT) — the localhost origin always uses this. */
  readonly webPort: string;
  /**
   * The host public origin supplied by the operator before setup. A full origin (`https://jarvis.example.com`,
   * `http://192.168.1.50:5173`) is used as-is; a bare host/IP (`192.168.1.50`, `jarvis.lan`) is
   * normalized to `http://<host>:<webPort>`. Empty/undefined ⇒ localhost-only (current behavior).
   */
  readonly publicOrigin?: string;
  /**
   * An explicit JARVIS_AUTH_TRUSTED_ORIGINS operator override. When set (non-empty), it WINS
   * verbatim — the operator has taken full control of the list (back-compat with the prior
   * behavior where this env value was used as-is).
   */
  readonly override?: string;
  /**
   * NEW, optional (#1505). When set, this exact origin (after trailing-slash normalization) must
   * end up in the resulting list — including inside an explicit override — or the call throws
   * TlsConfigError. This is the no-lockout guarantee: a deployment never starts serving HTTPS on
   * an origin better-auth will then reject (D9).
   */
  readonly httpsOrigin?: string;
}

/** True for a string that already looks like a full origin (has a scheme). */
function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/**
 * Normalize a publicOrigin token to a full origin. A value WITH a scheme is trusted as-is
 * (minus any trailing slash); a bare host/IP becomes `http://<host>:<webPort>`.
 */
function normalizeOrigin(value: string, webPort: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (hasScheme(trimmed)) return trimmed;
  return `http://${trimmed}:${webPort}`;
}

/** Strip a trailing slash only, for exact-string origin comparison (D10). */
function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Build the comma-joined JARVIS_AUTH_TRUSTED_ORIGINS value.
 *
 * - An explicit `override` wins verbatim (operator took control) — UNLESS `httpsOrigin` is set
 *   and absent from the override, in which case this throws TlsConfigError (D9/D10): comparison
 *   is exact-string after trailing-slash normalization, case-sensitive.
 * - Otherwise: `http://localhost:<webPort>` + the normalized `publicOrigin` (if any) + `httpsOrigin`
 *   (if any), DEDUPED in first-seen order. The localhost origin is always present so an on-box /
 *   port-forward reach still works.
 *
 * The result is parsed back at runtime by `resolveAuthOriginConfig` (packages/auth), which
 * comma-splits / trims / filters — so a comma-joined list is exactly the right shape.
 */
export function deriveTrustedOrigins(input: DeriveTrustedOriginsInput): string {
  const override = input.override?.trim();
  if (override) {
    if (input.httpsOrigin) {
      const overrideMembers = new Set(
        override.split(",").map((member) => stripTrailingSlash(member.trim()))
      );
      if (!overrideMembers.has(stripTrailingSlash(input.httpsOrigin))) {
        throw new TlsConfigError(
          `JARVIS_AUTH_TRUSTED_ORIGINS is set but does not include the requested HTTPS origin ` +
            `(${input.httpsOrigin}). A deployment would start and then reject every sign-in from ` +
            "that origin. Add it to the override list, or unset the override to derive it automatically."
        );
      }
    }
    return override;
  }

  const origins: string[] = [`http://localhost:${input.webPort}`];
  if (input.publicOrigin) {
    const normalized = normalizeOrigin(input.publicOrigin, input.webPort);
    if (normalized) origins.push(normalized);
  }
  if (input.httpsOrigin) origins.push(input.httpsOrigin);
  // Dedup, first-seen order.
  return [...new Set(origins)].join(",");
}
