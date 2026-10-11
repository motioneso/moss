import { UAT_PORT_RANGE_SIZE, UAT_PORT_RANGE_START } from "../provisioner.js";

/** Match the unnormalized complete card text, never a whitespace-normalized/truncated command. */
export function isExactNativeReadSummary(actual: string | null, requestedCommand: string): boolean {
  // ACP's card renderer truncates a command at 200 characters. The requested fixture command
  // must be shorter, so a truncated longer proposal cannot equal this complete expected text.
  return (
    requestedCommand.length < 200 && actual === `The agent wants to use Bash: ${requestedCommand}`
  );
}

const SHARED_DEV_PORTS = { first: 5180, last: 5299 } as const;

export interface DisposableStackTarget {
  readonly baseURL: string;
  readonly projectName: string;
  /** The port the harness bound from JARVIS_UAT_CLAIMED_WEB_PORT, when one was claimed. */
  readonly claimedWebPort: number | undefined;
}

/**
 * Every reason the target is not the harness's own throwaway stack. A claimed run binds exactly
 * its devports claim; otherwise the provisioner picks from the reserved UAT range.
 */
export function disposableStackProblems(target: DisposableStackTarget): string[] {
  const url = new URL(target.baseURL);
  const port = url.port === "" ? Number.NaN : Number(url.port);
  const claim = target.claimedWebPort;
  const found: string[] = [];
  if (url.protocol !== "http:") found.push("protocol is not http");
  if (url.hostname !== "127.0.0.1") found.push("host is not 127.0.0.1");
  if (url.username + url.password + url.search + url.hash !== "") {
    found.push("URL carries credentials, a query or a fragment");
  }
  if (url.pathname !== "/") found.push("URL has a path");
  if (!/^uat-\d+_[0-9a-f]{8}$/.test(target.projectName)) {
    found.push("project is not a generated UAT project");
  }
  if (claim !== undefined && (claim < SHARED_DEV_PORTS.first || claim > SHARED_DEV_PORTS.last)) {
    found.push("claimed port is outside the shared dev range");
  }
  const allowed =
    claim === undefined
      ? port >= UAT_PORT_RANGE_START && port < UAT_PORT_RANGE_START + UAT_PORT_RANGE_SIZE
      : port === claim;
  if (!allowed) found.push("port is not the harness's");
  return found;
}
