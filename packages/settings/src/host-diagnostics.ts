import type {
  ChatMultiplexerAvailability,
  ChatMultiplexerChoice,
  HostDiagnosticCheckDto,
  HostDiagnosticsDto,
  HostDiagnosticsInfo
} from "@moss/shared";

/**
 * Host diagnostics — pure serializer + safety guard (#255).
 *
 * The PRIMARY safety boundary is explicit allowlisted construction: the DTO is
 * assembled field-by-field from the typed `HostDiagnosticsInfo` the composition
 * root supplies plus fixed, secret-free check strings. We never spread
 * `process.env`, a config object, or a connection string into the output.
 *
 * `assertDiagnosticsSafe` is defense-in-depth on top of that boundary: it scans
 * every string the DTO would emit and throws if any connection URL or known
 * secret-env-key name slipped in, so a future change that wires a tainted value
 * into a `detail` fails loudly instead of leaking.
 */

/**
 * Injected by the API composition root. `info()` returns sync, non-secret runtime
 * facts; `pgBossInstalled()` is a cheap async connectivity probe. Defined here (not
 * in @moss/shared) so it stays a server-side seam; settings gains no new package
 * dependency by accepting it.
 */
export interface HostDiagnosticsProvider {
  readonly info: () => HostDiagnosticsInfo;
  readonly pgBossInstalled: () => Promise<boolean>;
}

export interface BuildHostDiagnosticsInput {
  readonly info: HostDiagnosticsInfo;
  readonly multiplexer: ChatMultiplexerChoice;
  readonly available: ChatMultiplexerAvailability;
  readonly dbOk: boolean;
  readonly pgBossOk: boolean;
  readonly latestAvailableVersion: string | null;
  readonly releaseNotes: string | null;
}

// Known secret-bearing env key names that must never appear in any output string.
const FORBIDDEN_SECRET_KEYS: readonly string[] = [
  "JARVIS_CONNECTOR_SECRET_KEY",
  "MOSS_CONNECTOR_SECRET_KEY",
  "JARVIS_AI_SECRET_KEY",
  "MOSS_AI_SECRET_KEY",
  "BETTER_AUTH_SECRET",
  "DATABASE_URL",
  "JARVIS_DATABASE_URL",
  "MOSS_DATABASE_URL"
];

// Any URL scheme (postgres://, postgresql://, redis://, https://…) — connection
// strings and creds-in-URL (scheme://user:pass@host) must not leak.
const CONNECTION_URL = /\b[a-z][a-z0-9+.-]*:\/\//i;
export const CREDS_IN_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i;

export function buildHostDiagnostics(input: BuildHostDiagnosticsInput): HostDiagnosticsDto {
  const { info, multiplexer, available, dbOk, pgBossOk, latestAvailableVersion, releaseNotes } =
    input;

  const muxAvailable = available.tmux || available.herdr;
  const checks: readonly HostDiagnosticCheckDto[] = [
    {
      id: "database",
      label: "Database connectivity",
      status: dbOk ? "pass" : "fail",
      detail: dbOk ? "Connected" : "Unreachable"
    },
    {
      id: "pgboss",
      label: "Job queue (pg-boss)",
      status: pgBossOk ? "pass" : "fail",
      detail: pgBossOk ? "Installed and reachable" : "Not installed or unreachable"
    },
    {
      id: "multiplexer",
      label: "Session multiplexer",
      status: muxAvailable ? "pass" : "warn",
      detail: muxAvailable ? "A multiplexer is available" : "No multiplexer available on this host"
    }
  ];

  const dto: HostDiagnosticsDto = {
    uptimeSeconds: info.uptimeSeconds,
    environment: info.environment,
    version: info.version,
    commit: info.commit,
    host: info.host,
    port: info.port,
    logLevel: info.logLevel,
    deployMode: info.deployMode,
    restartCommand: info.restartCommand,
    moduleCount: info.moduleCount,
    routeCount: info.routeCount,
    multiplexer,
    available: { tmux: available.tmux, herdr: available.herdr },
    checks,
    latestAvailableVersion,
    releaseNotes
  };

  // Belt-and-suspenders: refuse to emit anything that looks like a secret/URL.
  assertDiagnosticsSafe(dto);
  return dto;
}

/**
 * Throws if any string the DTO would serialize contains a connection URL or names a
 * known secret env key. The host/port info fields are config, not secrets, so a bare
 * host like "0.0.0.0" passes; a full `scheme://…` connection string does not.
 */
export function assertDiagnosticsSafe(dto: HostDiagnosticsDto): void {
  const strings: string[] = [
    dto.environment,
    dto.host,
    dto.logLevel,
    dto.deployMode,
    dto.multiplexer,
    dto.version ?? "",
    dto.commit ?? "",
    dto.restartCommand ?? ""
  ];
  for (const check of dto.checks) {
    strings.push(check.id, check.label, check.status, check.detail);
  }

  for (const value of strings) {
    if (CONNECTION_URL.test(value) || CREDS_IN_URL.test(value)) {
      throw new Error("host diagnostics contains a forbidden connection URL");
    }
    for (const key of FORBIDDEN_SECRET_KEYS) {
      if (value.includes(key)) {
        throw new Error("host diagnostics contains a forbidden secret reference");
      }
    }
  }
}
