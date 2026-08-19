import { describe, expect, it, vi } from "vitest";

import { geocodeIp } from "../../packages/weather/src/ip-geocoder.js";

function fetchStub() {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ success: true, latitude: 1, longitude: 2, city: "X", country: "Y" })
  })) as unknown as typeof fetch;
}

describe("geocodeIp private/non-routable range guard", () => {
  it.each([
    ["172.20.1.1", "RFC 1918 172.16.0.0/12 (octet2=20)"],
    ["172.16.0.1", "RFC 1918 lower boundary (octet2=16)"],
    ["172.31.255.255", "RFC 1918 upper boundary (octet2=31)"],
    ["169.254.1.1", "link-local 169.254.0.0/16"],
    ["100.64.0.1", "CGNAT 100.64.0.0/10"],
    ["10.0.0.1", "RFC 1918 10.0.0.0/8"],
    ["192.168.1.1", "RFC 1918 192.168.0.0/16"],
    ["127.0.0.1", "loopback"],
    ["::1", "IPv6 loopback"]
  ])("blocks %s (%s)", async (ip) => {
    const fetchFn = fetchStub();
    await expect(geocodeIp(ip, fetchFn)).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    ["172.32.1.1", "just above the RFC 1918 range (octet2=32) — the regression case"],
    ["172.15.255.255", "just below the RFC 1918 range (octet2=15)"],
    ["100.63.255.255", "just below CGNAT range"],
    ["100.128.0.1", "just above CGNAT range"],
    ["8.8.8.8", "ordinary public IP"]
  ])("does not block %s (%s)", async (ip) => {
    const fetchFn = fetchStub();
    await expect(geocodeIp(ip, fetchFn)).resolves.not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
