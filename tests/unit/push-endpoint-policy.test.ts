import { describe, expect, it, vi } from "vitest";

import {
  PushSubscriptionInvalidError,
  createGuardedLookup,
  createPushHttpsAgent,
  isPrivateAddress,
  isPrivateHostname,
  validatePushEndpoint,
  validatePushSubscriptionInput
} from "@moss/notifications";

// 65-byte P-256 point and 16-byte auth secret, base64url: the sizes the Web Push spec fixes.
const P256DH = "B".repeat(87);
const AUTH = "a".repeat(22);

describe("validatePushEndpoint (#743 security finding 1)", () => {
  it("accepts a public https push service address", () => {
    expect(validatePushEndpoint("https://fcm.googleapis.com/fcm/send/abc-123")).toBe(
      "https://fcm.googleapis.com/fcm/send/abc-123"
    );
  });

  it.each([
    ["http://fcm.googleapis.com/fcm/send/abc", "must use https"],
    ["ftp://fcm.googleapis.com/x", "must use https"],
    ["javascript:alert(1)", "must use https"],
    ["not a url", "invalid characters"],
    ["https://user:pw@push.example.com/x", "credentials"],
    ["https://user@push.example.com/x", "credentials"],
    ["https://127.0.0.1/x", "public push service"],
    ["https://10.1.2.3/x", "public push service"],
    ["https://[::1]/x", "public push service"],
    ["https://[fe80::1]/x", "public push service"],
    ["https://localhost/x", "public push service"],
    ["https://LOCALHOST/x", "public push service"],
    ["https://push.localhost/x", "public push service"],
    ["https://printer.local/x", "public push service"],
    ["https://vault.internal/x", "public push service"],
    ["https://nas.home.arpa/x", "public push service"],
    ["https://intranet/x", "public push service"],
    ["https://push.example.com/a\nb", "invalid characters"],
    ["https://push.example.com/a b", "invalid characters"],
    [`https://push.example.com/${"a".repeat(2100)}`, "too long"],
    ["", "required"]
  ])("refuses %s", (endpoint, reason) => {
    expect(() => validatePushEndpoint(endpoint)).toThrow(PushSubscriptionInvalidError);
    expect(() => validatePushEndpoint(endpoint)).toThrow(reason);
  });
});

describe("validatePushSubscriptionInput", () => {
  it("returns the checked address and keys", () => {
    expect(
      validatePushSubscriptionInput({
        endpoint: "https://push.example.com/ep",
        p256dh: P256DH,
        auth: AUTH
      })
    ).toEqual({ endpoint: "https://push.example.com/ep", p256dh: P256DH, auth: AUTH });
  });

  it("accepts padded base64url keys", () => {
    expect(() =>
      validatePushSubscriptionInput({
        endpoint: "https://push.example.com/ep",
        p256dh: `${P256DH}=`,
        auth: `${AUTH}==`
      })
    ).not.toThrow();
  });

  it.each([
    ["short p256dh", { p256dh: "B".repeat(86), auth: AUTH }],
    ["long p256dh", { p256dh: "B".repeat(88), auth: AUTH }],
    ["standard base64 p256dh", { p256dh: `${"B".repeat(85)}+/`, auth: AUTH }],
    ["short auth", { p256dh: P256DH, auth: "a".repeat(21) }],
    ["long auth", { p256dh: P256DH, auth: "a".repeat(23) }],
    ["auth with a space", { p256dh: P256DH, auth: `${"a".repeat(21)} ` }]
  ])("refuses a malformed key: %s", (_label, keys) => {
    expect(() =>
      validatePushSubscriptionInput({ endpoint: "https://push.example.com/ep", ...keys })
    ).toThrow(PushSubscriptionInvalidError);
  });
});

describe("isPrivateHostname / isPrivateAddress", () => {
  it("treats public names and addresses as public", () => {
    expect(isPrivateHostname("updates.push.services.mozilla.com")).toBe(false);
    expect(isPrivateAddress("142.250.72.14")).toBe(false);
    expect(isPrivateAddress("2606:4700::6810:84e5")).toBe(false);
  });

  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.168.50.36",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "100::1"
  ])("treats %s as private", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it("treats a public IPv4 range boundary correctly", () => {
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("100.128.0.1")).toBe(false);
    expect(isPrivateAddress("9.255.255.255")).toBe(false);
  });
});

describe("createGuardedLookup (DNS rebinding)", () => {
  function fakeBase(answer: string | { address: string; family: number }[]) {
    return vi.fn((hostname: string, options: unknown, callback?: unknown) => {
      const cb = (typeof options === "function" ? options : callback) as (
        err: Error | null,
        address?: unknown,
        family?: number
      ) => void;
      if (Array.isArray(answer)) {
        cb(null, answer);
      } else {
        cb(null, answer, 4);
      }
    });
  }

  function lookupOnce(
    lookup: ReturnType<typeof createGuardedLookup>,
    hostname: string
  ): Promise<{ err: NodeJS.ErrnoException | null; address?: unknown }> {
    return new Promise((resolve) => {
      (lookup as unknown as (h: string, o: unknown, cb: unknown) => void)(
        hostname,
        { family: 0 },
        (err: NodeJS.ErrnoException | null, address?: unknown) => resolve({ err, address })
      );
    });
  }

  it("passes a public answer through untouched", async () => {
    const base = fakeBase("142.250.72.14");
    const result = await lookupOnce(createGuardedLookup(base as never), "push.example.com");
    expect(result.err).toBeNull();
    expect(result.address).toBe("142.250.72.14");
  });

  it("fails when a public name resolves to a loopback address", async () => {
    const base = fakeBase("127.0.0.1");
    const result = await lookupOnce(createGuardedLookup(base as never), "push.example.com");
    expect(result.err?.code).toBe("EPUSHPRIVATEADDRESS");
    expect(result.address).toBeUndefined();
  });

  it("fails when any address in an all-answers list is private", async () => {
    const base = fakeBase([
      { address: "142.250.72.14", family: 4 },
      { address: "192.168.50.36", family: 4 }
    ]);
    const result = await lookupOnce(createGuardedLookup(base as never), "push.example.com");
    expect(result.err?.code).toBe("EPUSHPRIVATEADDRESS");
  });

  it("fails when a public name resolves to a v4-mapped private IPv6 address", async () => {
    const base = fakeBase([{ address: "::ffff:10.0.0.5", family: 6 }]);
    const result = await lookupOnce(createGuardedLookup(base as never), "push.example.com");
    expect(result.err?.code).toBe("EPUSHPRIVATEADDRESS");
  });

  it("never asks DNS about a private hostname", async () => {
    const base = fakeBase("1.2.3.4");
    const result = await lookupOnce(createGuardedLookup(base as never), "localhost");
    expect(result.err?.code).toBe("EPUSHPRIVATEADDRESS");
    expect(base).not.toHaveBeenCalled();
  });

  it("builds an https agent that uses the guarded lookup", () => {
    const lookup = createGuardedLookup(fakeBase("1.2.3.4") as never);
    const agent = createPushHttpsAgent(lookup);
    expect((agent.options as { lookup?: unknown }).lookup).toBe(lookup);
    expect(agent.options.timeout).toBe(10_000);
    agent.destroy();
  });
});
