/**
 * Unit test for resolveApiServerConfig MCP server URL source (v0.1.4 deploy fix).
 *
 * In the container deploy the CLI runs in a separate `cli-runner` container, so a
 * hardcoded `http://127.0.0.1:${PORT}/api/mcp` resolves to the cli-runner itself and the
 * MCP gateway is unreachable (Jarvis loads zero tools). The config must honor
 * `JARVIS_MCP_SERVER_URL` (compose default `http://api:3000/api/mcp`) when set, and keep
 * the loopback default for dev/non-container runs when it is unset.
 */
import { describe, expect, it } from "vitest";
import type { FastifyBaseLogger } from "fastify";

import { buildSportsBriefingSource } from "@moss/module-registry";

import {
  createApiServer,
  resolveApiServerConfig,
  resolveTrustProxy
} from "../../apps/api/src/server.js";

describe("resolveTrustProxy", () => {
  it("disables proxy trust when unset or empty", () => {
    expect(resolveTrustProxy(undefined)).toBe(false);
    expect(resolveTrustProxy("   ")).toBe(false);
  });

  it("keeps loopback as the host-dev proxy keyword", () => {
    expect(resolveTrustProxy("LOOPBACK")).toBe("loopback");
  });

  it("accepts exact IPv4 and IPv6 proxy addresses, including lists", () => {
    expect(resolveTrustProxy("10.251.0.2")).toBe("10.251.0.2");
    expect(resolveTrustProxy("10.251.0.2, 2001:db8::2")).toEqual(["10.251.0.2", "2001:db8::2"]);
  });

  it("rejects legacy booleans, CIDRs, and malformed values", () => {
    for (const value of ["1", "true", "YES", "on", "10.251.0.0/24", "proxy.example"]) {
      expect(() => resolveTrustProxy(value)).toThrow(
        'JARVIS_TRUST_PROXY must be unset, "loopback", or a comma-separated list of exact IP addresses'
      );
    }
  });

  it("rejects invalid configuration before creating database clients", () => {
    const previous = process.env.JARVIS_TRUST_PROXY;
    process.env.JARVIS_TRUST_PROXY = "true";
    try {
      expect(() => createApiServer({ logger: false })).toThrow(
        'JARVIS_TRUST_PROXY must be unset, "loopback", or a comma-separated list of exact IP addresses'
      );
    } finally {
      if (previous === undefined) delete process.env.JARVIS_TRUST_PROXY;
      else process.env.JARVIS_TRUST_PROXY = previous;
    }
  });
});

describe("resolveApiServerConfig MCP server URL", () => {
  it("honors JARVIS_MCP_SERVER_URL when set (container deploy), ignoring PORT", () => {
    const config = resolveApiServerConfig({
      PORT: "4100",
      JARVIS_MCP_SERVER_URL: "http://api:3000/api/mcp"
    } as NodeJS.ProcessEnv);

    expect(config.mcpServerUrl).toBe("http://api:3000/api/mcp");
  });

  it("falls back to the loopback URL with the configured PORT when env is unset (dev)", () => {
    const config = resolveApiServerConfig({ PORT: "4100" } as NodeJS.ProcessEnv);

    expect(config.mcpServerUrl).toBe("http://127.0.0.1:4100/api/mcp");
  });

  it("aligns loopback JARVIS_MCP_SERVER_URL port with PORT when set (#2345)", () => {
    const configIpv4 = resolveApiServerConfig({
      PORT: "4100",
      JARVIS_MCP_SERVER_URL: "http://127.0.0.1:3000/api/mcp"
    } as NodeJS.ProcessEnv);
    expect(configIpv4.mcpServerUrl).toBe("http://127.0.0.1:4100/api/mcp");

    const configLocalhost = resolveApiServerConfig({
      PORT: "4200",
      JARVIS_MCP_SERVER_URL: "http://localhost:3000/api/mcp"
    } as NodeJS.ProcessEnv);
    expect(configLocalhost.mcpServerUrl).toBe("http://localhost:4200/api/mcp");

    const configIpv6 = resolveApiServerConfig({
      PORT: "4300",
      JARVIS_MCP_SERVER_URL: "http://[::1]:3000/api/mcp"
    } as NodeJS.ProcessEnv);
    expect(configIpv6.mcpServerUrl).toBe("http://[::1]:4300/api/mcp");
  });
});

describe("resolveApiServerConfig external modules dir (#996, #860)", () => {
  it("honors JARVIS_MODULES_DIR when set", () => {
    const config = resolveApiServerConfig({
      JARVIS_MODULES_DIR: "/srv/modules"
    } as NodeJS.ProcessEnv);
    expect(config.externalModulesDir).toBe("/srv/modules");
  });

  it("falls back to a resolved dev default when unset (never null)", () => {
    const config = resolveApiServerConfig({} as NodeJS.ProcessEnv);
    expect(typeof config.externalModulesDir).toBe("string");
    expect(config.externalModulesDir.length).toBeGreaterThan(0);
  });

  it("no longer exposes enableExternalModules", () => {
    const config = resolveApiServerConfig({} as NodeJS.ProcessEnv);
    expect((config as unknown as Record<string, unknown>).enableExternalModules).toBeUndefined();
  });
});

describe("sports route client e2e error detail ([task:uat-espn-fetch-error-log])", () => {
  // Full-server boot needs a database, so this case exercises the exact builder
  // the sports overview route constructs its dataset client from, with the same
  // options the route construction passes: the flag arrives from the server
  // options through the route dependencies.
  function throwingFetch(): typeof fetch {
    return (async () => {
      throw new Error("fixture refused");
    }) as typeof fetch;
  }

  function warnCapture() {
    const warnings: Array<[Record<string, unknown>, string]> = [];
    const logger = {
      child: () => ({
        warn: (data: Record<string, unknown>, message: string) => {
          warnings.push([data, message]);
        }
      })
    } as unknown as FastifyBaseLogger;
    return { logger, warnings };
  }

  it("warns with errorMessage and targetHost when the flag is set, omits both without it", async () => {
    const flagged = warnCapture();
    const flaggedClient = buildSportsBriefingSource({
      fetchFn: throwingFetch(),
      logger: flagged.logger,
      e2eErrorDetail: true
    });
    await flaggedClient.getDataset(
      "scoreboard",
      { competitionKey: "eng.1", day: "2026-09-15" },
      { fallback: null }
    );
    expect(flagged.warnings).toHaveLength(1);
    expect(flagged.warnings[0]?.[1]).toBe("dataset fetch failed: serving degraded response");
    expect(flagged.warnings[0]?.[0]).toMatchObject({
      sourceId: "espn",
      errorMessage: "fixture refused"
    });
    expect(typeof (flagged.warnings[0]?.[0] as Record<string, unknown>).targetHost).toBe("string");

    const plain = warnCapture();
    const plainClient = buildSportsBriefingSource({
      fetchFn: throwingFetch(),
      logger: plain.logger
    });
    await plainClient.getDataset(
      "scoreboard",
      { competitionKey: "eng.1", day: "2026-09-15" },
      { fallback: null }
    );
    expect(plain.warnings).toHaveLength(1);
    expect(plain.warnings[0]?.[0]).not.toHaveProperty("errorMessage");
    expect(plain.warnings[0]?.[0]).not.toHaveProperty("targetHost");
  });
});
