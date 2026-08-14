import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";

export const UAT_SUBNET_CANDIDATES: readonly string[] = [
  "10.254.0.0/24",
  "10.255.0.0/24",
  ...Array.from({ length: 11 }, (_, index) => `10.${240 + index}.0.0/24`)
];

export const UAT_FORBIDDEN_SUBNETS: ReadonlyArray<{
  readonly cidr: string;
  readonly reason: string;
}> = [
  { cidr: "10.251.0.0/24", reason: "reserved for the infra/dev stack" },
  { cidr: "10.252.0.0/24", reason: "reserved for production" },
  { cidr: "10.253.0.0/24", reason: "reserved for compose smoke tests" }
];

export class UatSubnetSelectionError extends Error {}

function maskFor(prefixLength: number): number {
  return prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
}

/** Throws on anything that is not a valid IPv4 CIDR. */
export function parseIpv4Cidr(cidr: string): {
  readonly base: number;
  readonly prefixLength: number;
} {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(0|[1-9][0-9]?)$/.exec(cidr);
  if (!match) {
    throw new UatSubnetSelectionError(`invalid IPv4 CIDR: ${cidr || "<empty>"}`);
  }
  const addressText = match.slice(1, 5).join(".");
  const octets = match.slice(1, 5).map(Number);
  const prefixLength = Number(match[5]);
  if (isIP(addressText) !== 4 || prefixLength > 32) {
    throw new UatSubnetSelectionError(`invalid IPv4 CIDR: ${cidr}`);
  }
  const address = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  return { base: (address & maskFor(prefixLength)) >>> 0, prefixLength };
}

export function cidrsOverlap(a: string, b: string): boolean {
  const parsedA = parseIpv4Cidr(a);
  const parsedB = parseIpv4Cidr(b);
  const mask = maskFor(Math.min(parsedA.prefixLength, parsedB.prefixLength));
  return (parsedA.base & mask) >>> 0 === (parsedB.base & mask) >>> 0;
}

export function findSkippedUatNetworks(
  live: ReadonlyArray<{
    readonly networkName: string;
    readonly subnet: string;
    readonly composeProject?: string;
  }>,
  candidates: readonly string[]
): ReadonlyArray<{
  readonly networkName: string;
  readonly subnet: string;
  readonly composeProject?: string;
}> {
  return live.filter(
    (network) =>
      network.composeProject?.startsWith("uat-") === true &&
      candidates.some((candidate) => cidrsOverlap(candidate, network.subnet))
  );
}

type Capture = (command: string, args: readonly string[]) => Promise<string>;
const execFileAsync = promisify(execFile);

const captureCommand: Capture = async (command, args) => {
  const { stdout } = await execFileAsync(command, [...args], { encoding: "utf8" });
  return stdout;
};

function isIpv6Cidr(cidr: string): boolean {
  const [address, prefix, extra] = cidr.split("/");
  return (
    extra === undefined &&
    address !== undefined &&
    isIP(address) === 6 &&
    prefix !== undefined &&
    /^\d+$/.test(prefix) &&
    Number(prefix) <= 128
  );
}

/** Read-only enumeration of live Docker IPv4 subnets. */
export async function listLiveDockerSubnets(capture: Capture = captureCommand): Promise<
  ReadonlyArray<{
    readonly networkName: string;
    readonly subnet: string;
    readonly composeProject?: string;
  }>
> {
  const ids = (await capture("docker", ["network", "ls", "-q"])).split("\n").filter(Boolean);
  if (ids.length === 0) return [];

  let inspected: unknown;
  try {
    inspected = JSON.parse(await capture("docker", ["network", "inspect", ...ids]));
  } catch (error) {
    throw new UatSubnetSelectionError(`could not inspect Docker network IPAM: ${String(error)}`);
  }
  if (!Array.isArray(inspected)) {
    throw new UatSubnetSelectionError("Docker network inspect returned a non-array response");
  }

  const live: Array<{
    readonly networkName: string;
    readonly subnet: string;
    readonly composeProject?: string;
  }> = [];
  for (const network of inspected) {
    if (typeof network !== "object" || network === null || Array.isArray(network)) {
      throw new UatSubnetSelectionError("Docker network inspect returned a malformed record");
    }
    const record = network as Record<string, unknown>;
    if (typeof record.Name !== "string" || record.Name.length === 0) {
      throw new UatSubnetSelectionError("Docker network inspect record has an invalid name");
    }
    const networkName = record.Name;
    if (typeof record.IPAM !== "object" || record.IPAM === null || Array.isArray(record.IPAM)) {
      throw new UatSubnetSelectionError(`Docker network ${networkName} has malformed IPAM`);
    }
    const configs = (record.IPAM as Record<string, unknown>).Config;
    if (!Array.isArray(configs)) {
      throw new UatSubnetSelectionError(`Docker network ${networkName} has malformed IPAM config`);
    }
    if (
      typeof record.Labels !== "object" ||
      record.Labels === null ||
      Array.isArray(record.Labels)
    ) {
      throw new UatSubnetSelectionError(`Docker network ${networkName} has malformed labels`);
    }
    const composeProject = (record.Labels as Record<string, unknown>)["com.docker.compose.project"];
    if (
      composeProject !== undefined &&
      (typeof composeProject !== "string" || composeProject.length === 0)
    ) {
      throw new UatSubnetSelectionError(
        `Docker network ${networkName} has an invalid Compose project label`
      );
    }
    for (const config of configs) {
      if (typeof config !== "object" || config === null || Array.isArray(config)) {
        throw new UatSubnetSelectionError(
          `Docker network ${networkName} has a malformed IPAM config entry`
        );
      }
      const subnet = (config as { Subnet?: unknown }).Subnet;
      if (typeof subnet !== "string" || subnet.length === 0) {
        throw new UatSubnetSelectionError(
          `Docker network ${networkName} has a malformed IPAM subnet`
        );
      }
      if (subnet.includes(":")) {
        if (isIpv6Cidr(subnet)) continue;
        throw new UatSubnetSelectionError(
          `Docker network ${networkName} has invalid IPv6 subnet ${subnet}`
        );
      }
      try {
        parseIpv4Cidr(subnet);
      } catch (error) {
        throw new UatSubnetSelectionError(
          `Docker network ${networkName} has invalid IPv4 subnet ${subnet}: ${String(error)}`
        );
      }
      live.push({
        networkName,
        subnet,
        ...(typeof composeProject === "string" ? { composeProject } : {})
      });
    }
  }
  return live;
}

/** Pure fail-closed selection over an already-enumerated live network set. */
export function selectUatSubnet(input: {
  readonly requested: string | undefined;
  readonly live: ReadonlyArray<{ readonly networkName: string; readonly subnet: string }>;
  readonly candidates?: readonly string[];
}): { readonly subnet: string; readonly source: "requested" | "auto" } {
  if (input.requested !== undefined) {
    parseIpv4Cidr(input.requested);
    const forbidden = UAT_FORBIDDEN_SUBNETS.find((entry) =>
      cidrsOverlap(input.requested!, entry.cidr)
    );
    const collision = input.live.find((network) => cidrsOverlap(input.requested!, network.subnet));
    if (collision) {
      throw new UatSubnetSelectionError(
        `requested UAT subnet ${input.requested} overlaps live Docker network ${collision.networkName} (${collision.subnet})${forbidden ? `; ${forbidden.reason}` : ""}`
      );
    }
    if (forbidden) {
      throw new UatSubnetSelectionError(
        `requested UAT subnet ${input.requested} overlaps ${forbidden.cidr}, ${forbidden.reason}`
      );
    }
    return { subnet: input.requested, source: "requested" };
  }

  const candidate = (input.candidates ?? UAT_SUBNET_CANDIDATES).find(
    (cidr) =>
      !UAT_FORBIDDEN_SUBNETS.some((entry) => cidrsOverlap(cidr, entry.cidr)) &&
      !input.live.some((network) => cidrsOverlap(cidr, network.subnet))
  );
  if (!candidate) {
    throw new UatSubnetSelectionError("no free UAT Docker subnet remains in the reserved pool");
  }
  return { subnet: candidate, source: "auto" };
}
