import { describe, expect, it } from "vitest";

import {
  UAT_FORBIDDEN_SUBNETS,
  UAT_SUBNET_CANDIDATES,
  UatSubnetSelectionError,
  cidrsOverlap,
  listLiveDockerSubnets,
  parseIpv4Cidr,
  selectUatSubnet
} from "../uat/subnet-selection.js";

describe("IPv4 CIDR handling", () => {
  it("detects identity, containment, adjacency, and unrelated ranges", () => {
    expect(cidrsOverlap("10.252.0.0/24", "10.252.0.0/24")).toBe(true);
    expect(cidrsOverlap("10.0.0.0/8", "10.252.0.0/24")).toBe(true);
    expect(cidrsOverlap("10.252.0.0/24", "10.0.0.0/8")).toBe(true);
    expect(cidrsOverlap("10.254.0.0/24", "10.255.0.0/24")).toBe(false);
    expect(cidrsOverlap("172.17.0.0/16", "10.254.0.0/24")).toBe(false);
  });

  it.each(["10.252.0.0", "10.252.0.0/33", "fd00::/64", ""])(
    "rejects invalid IPv4 CIDR %j",
    (cidr) => {
      expect(() => parseIpv4Cidr(cidr)).toThrow(UatSubnetSelectionError);
    }
  );
});

describe("selectUatSubnet", () => {
  it("defaults to the first reserved candidate", () => {
    expect(selectUatSubnet({ requested: undefined, live: [] })).toEqual({
      subnet: "10.254.0.0/24",
      source: "auto"
    });
  });

  it("skips candidates overlapping live networks", () => {
    expect(
      selectUatSubnet({
        requested: undefined,
        live: [
          { networkName: "first", subnet: "10.254.0.0/24" },
          { networkName: "second", subnet: "10.255.0.0/24" }
        ]
      })
    ).toEqual({ subnet: "10.240.0.0/24", source: "auto" });
  });

  it("never auto-selects a forbidden candidate override", () => {
    expect(
      selectUatSubnet({
        requested: undefined,
        live: [],
        candidates: ["10.252.0.0/24", "10.254.0.0/24"]
      })
    ).toEqual({ subnet: "10.254.0.0/24", source: "auto" });
  });

  it("refuses a requested live overlap and names the network", () => {
    expect(() =>
      selectUatSubnet({
        requested: "10.251.0.0/24",
        live: [{ networkName: "infra_jarv1s", subnet: "10.251.0.0/24" }]
      })
    ).toThrow(/10\.251\.0\.0\/24.*infra_jarv1s.*10\.251\.0\.0\/24/i);
  });

  it("refuses the production reservation even when it is not live", () => {
    expect(() => selectUatSubnet({ requested: "10.252.0.0/24", live: [] })).toThrow(
      /10\.252\.0\.0\/24.*production/i
    );
  });

  it("accepts a free requested subnet verbatim", () => {
    expect(selectUatSubnet({ requested: "10.249.0.0/24", live: [] })).toEqual({
      subnet: "10.249.0.0/24",
      source: "requested"
    });
  });

  it("keeps the candidate pool distinct from every forbidden range", () => {
    expect(UAT_SUBNET_CANDIDATES).toHaveLength(13);
    expect(UAT_SUBNET_CANDIDATES[0]).toBe("10.254.0.0/24");
    for (const candidate of UAT_SUBNET_CANDIDATES) {
      for (const forbidden of UAT_FORBIDDEN_SUBNETS) {
        expect(cidrsOverlap(candidate, forbidden.cidr)).toBe(false);
      }
    }
  });
});

describe("listLiveDockerSubnets", () => {
  it("enumerates IPv4 IPAM while skipping IPv6 and networks without IPAM", async () => {
    const capture = async (_command: string, args: readonly string[]) => {
      if (args[1] === "ls") return "bridge-id\napp-id\n";
      return JSON.stringify([
        { Name: "bridge", IPAM: { Config: [{ Subnet: "172.17.0.0/16" }] } },
        {
          Name: "app",
          IPAM: { Config: [{ Subnet: "10.254.0.0/24" }, { Subnet: "fd00::/64" }] }
        },
        { Name: "host", IPAM: { Config: [] } }
      ]);
    };

    await expect(listLiveDockerSubnets(capture)).resolves.toEqual([
      { networkName: "bridge", subnet: "172.17.0.0/16" },
      { networkName: "app", subnet: "10.254.0.0/24" }
    ]);
  });

  it("fails closed on malformed Docker IPv4 IPAM", async () => {
    const capture = async (_command: string, args: readonly string[]) =>
      args[1] === "ls"
        ? "bad-id\n"
        : JSON.stringify([{ Name: "bad", IPAM: { Config: [{ Subnet: "10.1.2.3/99" }] } }]);

    await expect(listLiveDockerSubnets(capture)).rejects.toThrow(UatSubnetSelectionError);
  });
});
