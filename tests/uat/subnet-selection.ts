import { execFile } from "node:child_process";
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
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
  if (!match) {
    throw new UatSubnetSelectionError(`invalid IPv4 CIDR: ${cidr || "<empty>"}`);
  }
  const octets = match.slice(1, 5).map(Number);
  const prefixLength = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefixLength > 32) {
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

type Capture = (command: string, args: readonly string[]) => Promise<string>;
const execFileAsync = promisify(execFile);

const captureCommand: Capture = async (command, args) => {
  const { stdout } = await execFileAsync(command, [...args], { encoding: "utf8" });
  return stdout;
};

/** Read-only enumeration of live Docker IPv4 subnets. */
export async function listLiveDockerSubnets(
  capture: Capture = captureCommand
): Promise<ReadonlyArray<{ readonly networkName: string; readonly subnet: string }>> {
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

  const live: Array<{ readonly networkName: string; readonly subnet: string }> = [];
  for (const network of inspected) {
    if (typeof network !== "object" || network === null) continue;
    const record = network as { Name?: unknown; IPAM?: { Config?: unknown } };
    const networkName = typeof record.Name === "string" ? record.Name : "<unknown>";
    const configs = record.IPAM?.Config;
    if (!Array.isArray(configs)) continue;
    for (const config of configs) {
      if (typeof config !== "object" || config === null) continue;
      const subnet = (config as { Subnet?: unknown }).Subnet;
      if (typeof subnet !== "string" || subnet.includes(":")) continue;
      try {
        parseIpv4Cidr(subnet);
      } catch (error) {
        throw new UatSubnetSelectionError(
          `Docker network ${networkName} has invalid IPv4 subnet ${subnet}: ${String(error)}`
        );
      }
      live.push({ networkName, subnet });
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
    const collision = input.live.find((network) => cidrsOverlap(input.requested!, network.subnet));
    if (collision) {
      throw new UatSubnetSelectionError(
        `requested UAT subnet ${input.requested} overlaps live Docker network ${collision.networkName} (${collision.subnet})`
      );
    }
    const forbidden = UAT_FORBIDDEN_SUBNETS.find((entry) =>
      cidrsOverlap(input.requested!, entry.cidr)
    );
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
