import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  TlsConfigError,
  deriveCaddyProxyIp,
  deriveTrustedOrigins,
  resolveTlsSettings
} from "../../scripts/setup-prod-origins.js";

// #379 (v0.1.3): a real deploy is reached over LAN / tailnet / domain, not localhost. The setup
// container can't see the host LAN IP, so install.sh detects it and passes a public origin into
// setup; setup-prod.ts merges it (deduped) with the localhost origin. An explicit
// JARVIS_AUTH_TRUSTED_ORIGINS override still wins verbatim.
describe("deriveTrustedOrigins (#379)", () => {
  it("is localhost-only when no publicOrigin / override (current behavior preserved)", () => {
    expect(deriveTrustedOrigins({ webPort: "1533" })).toBe("http://localhost:1533");
  });

  it("honors a non-default web port for the localhost origin", () => {
    expect(deriveTrustedOrigins({ webPort: "8080" })).toBe("http://localhost:8080");
  });

  it("changes trusted origins with JARVIS_WEB_PORT without changing the default auth base URL", async () => {
    const setupProd = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../../scripts/setup-prod.ts", import.meta.url), "utf8")
    );

    expect(deriveTrustedOrigins({ webPort: "5179" })).toBe("http://localhost:5179");
    // #1443: the base URL is still a single independent read with a fixed default — it just goes
    // through the MOSS_*/JARVIS_* shim now. JARVIS_WEB_PORT stays a plain read (carve-out: compose
    // interpolates it host-side), which is what keeps the two knobs from being wired together.
    expect(setupProd).toContain(
      'resolveMossEnv(process.env, "JARVIS_AUTH_BASE_URL") ?? "http://localhost:3000"'
    );
  });

  it("appends a full publicOrigin verbatim, alongside the localhost origin", () => {
    expect(
      deriveTrustedOrigins({ webPort: "5173", publicOrigin: "http://192.168.1.50:5173" })
    ).toBe("http://localhost:5173,http://192.168.1.50:5173");
  });

  it("supports an https domain publicOrigin", () => {
    expect(
      deriveTrustedOrigins({ webPort: "5173", publicOrigin: "https://jarvis.example.com" })
    ).toBe("http://localhost:5173,https://jarvis.example.com");
  });

  it("normalizes a bare host/IP publicOrigin to http://<host>:<webPort>", () => {
    expect(deriveTrustedOrigins({ webPort: "5173", publicOrigin: "192.168.1.50" })).toBe(
      "http://localhost:5173,http://192.168.1.50:5173"
    );
    expect(deriveTrustedOrigins({ webPort: "5173", publicOrigin: "jarvis.lan" })).toBe(
      "http://localhost:5173,http://jarvis.lan:5173"
    );
  });

  it("dedupes a publicOrigin that equals the localhost origin", () => {
    expect(deriveTrustedOrigins({ webPort: "5173", publicOrigin: "http://localhost:5173" })).toBe(
      "http://localhost:5173"
    );
  });

  it("strips a trailing slash from the publicOrigin", () => {
    expect(
      deriveTrustedOrigins({ webPort: "5173", publicOrigin: "https://jarvis.example.com/" })
    ).toBe("http://localhost:5173,https://jarvis.example.com");
  });

  it("an explicit override wins verbatim (operator took control of the whole list)", () => {
    expect(
      deriveTrustedOrigins({
        webPort: "5173",
        publicOrigin: "http://192.168.1.50:5173",
        override: "https://a.example.com,https://b.example.com"
      })
    ).toBe("https://a.example.com,https://b.example.com");
  });

  it("ignores an empty/whitespace override (falls through to the derived list)", () => {
    expect(
      deriveTrustedOrigins({ webPort: "5173", publicOrigin: "192.168.1.50", override: "  " })
    ).toBe("http://localhost:5173,http://192.168.1.50:5173");
  });

  // #1505: the TLS HTTPS origin joins the same derived list, and the no-lockout guarantee
  // extends the override check to it.
  it("appends the httpsOrigin alongside localhost when no publicOrigin is set", () => {
    expect(deriveTrustedOrigins({ webPort: "1533", httpsOrigin: "https://jarvis.lan" })).toBe(
      "http://localhost:1533,https://jarvis.lan"
    );
  });

  it("orders localhost, publicOrigin, then httpsOrigin", () => {
    expect(
      deriveTrustedOrigins({
        webPort: "1533",
        publicOrigin: "http://192.168.1.50:1533",
        httpsOrigin: "https://jarvis.lan"
      })
    ).toBe("http://localhost:1533,http://192.168.1.50:1533,https://jarvis.lan");
  });

  it("dedupes an httpsOrigin equal to the normalized publicOrigin", () => {
    expect(
      deriveTrustedOrigins({
        webPort: "1533",
        publicOrigin: "https://jarvis.lan",
        httpsOrigin: "https://jarvis.lan"
      })
    ).toBe("http://localhost:1533,https://jarvis.lan");
  });

  it("accepts an override that contains the exact httpsOrigin", () => {
    expect(
      deriveTrustedOrigins({
        webPort: "1533",
        httpsOrigin: "https://jarvis.lan",
        override: "https://jarvis.lan,https://other.example.com"
      })
    ).toBe("https://jarvis.lan,https://other.example.com");
  });

  it("throws when an override omits the requested httpsOrigin", () => {
    expect(() =>
      deriveTrustedOrigins({
        webPort: "1533",
        httpsOrigin: "https://jarvis.lan",
        override: "https://other.example.com"
      })
    ).toThrow(TlsConfigError);
  });

  it("treats a trailing slash in the override member as present", () => {
    expect(
      deriveTrustedOrigins({
        webPort: "1533",
        httpsOrigin: "https://jarvis.lan",
        override: "https://jarvis.lan/"
      })
    ).toBe("https://jarvis.lan/");
  });

  it("is case-sensitive: an override with a different-case host still throws", () => {
    expect(() =>
      deriveTrustedOrigins({
        webPort: "1533",
        httpsOrigin: "https://jarvis.lan",
        override: "https://JARVIS.LAN"
      })
    ).toThrow(TlsConfigError);
  });
});

describe("resolveTlsSettings (#1505)", () => {
  const dockerSubnet = "10.251.0.0/24";

  it("returns undefined when the host is unset, empty, or whitespace-only", () => {
    expect(
      resolveTlsSettings({ host: undefined, issuer: undefined, dockerSubnet })
    ).toBeUndefined();
    expect(resolveTlsSettings({ host: "", issuer: undefined, dockerSubnet })).toBeUndefined();
    expect(resolveTlsSettings({ host: "   ", issuer: undefined, dockerSubnet })).toBeUndefined();
  });

  it("accepts a DNS host with issuer internal", () => {
    const settings = resolveTlsSettings({ host: "jarvis.lan", issuer: "internal", dockerSubnet });
    expect(settings).toEqual({
      host: "jarvis.lan",
      issuer: "internal",
      httpsOrigin: "https://jarvis.lan",
      trustProxyIp: "10.251.0.254"
    });
  });

  it("lowercases an uppercase host so the derived origin matches the real request Host header (#1505 review)", () => {
    const settings = resolveTlsSettings({
      host: "Jarv1s.Example.com",
      issuer: "internal",
      dockerSubnet
    });
    expect(settings).toEqual({
      host: "jarv1s.example.com",
      issuer: "internal",
      httpsOrigin: "https://jarv1s.example.com",
      trustProxyIp: "10.251.0.254"
    });
  });

  it("accepts a DNS host with issuer acme", () => {
    expect(
      resolveTlsSettings({ host: "jarvis.example.com", issuer: "acme", dockerSubnet })?.issuer
    ).toBe("acme");
  });

  it("accepts an IPv4 literal with issuer internal", () => {
    expect(
      resolveTlsSettings({ host: "192.168.1.50", issuer: "internal", dockerSubnet })?.httpsOrigin
    ).toBe("https://192.168.1.50");
  });

  it("rejects an IPv4 literal with issuer acme", () => {
    expect(() =>
      resolveTlsSettings({ host: "192.168.1.50", issuer: "acme", dockerSubnet })
    ).toThrow(TlsConfigError);
  });

  it("rejects IPv6, bare and bracketed", () => {
    expect(() => resolveTlsSettings({ host: "fd00::1", issuer: "internal", dockerSubnet })).toThrow(
      TlsConfigError
    );
    expect(() =>
      resolveTlsSettings({ host: "[fd00::1]", issuer: "internal", dockerSubnet })
    ).toThrow(TlsConfigError);
  });

  it.each([
    ["https://jarvis.lan", "scheme"],
    ["jarvis.lan:8443", "port"],
    ["user@jarvis.lan", "userinfo"],
    ["jarvis.lan/app", "path"],
    ["jarvis.lan?x=1", "query"],
    ["jarvis.lan#f", "fragment"],
    ["*.jarvis.lan", "wildcard"]
  ])("rejects %s (%s)", (host) => {
    expect(() => resolveTlsSettings({ host, issuer: "internal", dockerSubnet })).toThrow(
      TlsConfigError
    );
  });

  it("rejects whitespace and newline separated hosts", () => {
    expect(() =>
      resolveTlsSettings({ host: "jarvis.lan b.lan", issuer: "internal", dockerSubnet })
    ).toThrow(TlsConfigError);
    expect(() =>
      resolveTlsSettings({ host: "jarvis.lan\nb.lan", issuer: "internal", dockerSubnet })
    ).toThrow(TlsConfigError);
    expect(() =>
      resolveTlsSettings({ host: "jarvis.lan\tb.lan", issuer: "internal", dockerSubnet })
    ).toThrow(TlsConfigError);
  });

  it("rejects multiple-host separators", () => {
    expect(() =>
      resolveTlsSettings({ host: "jarvis.lan,b.lan", issuer: "internal", dockerSubnet })
    ).toThrow(TlsConfigError);
    expect(() =>
      resolveTlsSettings({ host: "jarvis.lan;b.lan", issuer: "internal", dockerSubnet })
    ).toThrow(TlsConfigError);
  });

  it("rejects Caddyfile placeholders and metacharacters", () => {
    for (const host of ["{$FOO}", "jarvis.{lan}", "jarvis.lan$X", "jarvis.lan|x"]) {
      expect(() => resolveTlsSettings({ host, issuer: "internal", dockerSubnet })).toThrow(
        TlsConfigError
      );
    }
  });

  it("rejects malformed DNS labels", () => {
    const longLabel = "a".repeat(64);
    const longTotal = Array.from({ length: 40 }, () => "abcdef").join(".") + ".com";
    for (const host of ["-jarvis.lan", "jarvis-.lan", "jarvis.lan.", longLabel, longTotal]) {
      expect(() => resolveTlsSettings({ host, issuer: "internal", dockerSubnet })).toThrow(
        TlsConfigError
      );
    }
  });

  it("every rejection carries a non-empty message", () => {
    try {
      resolveTlsSettings({ host: "https://jarvis.lan", issuer: "internal", dockerSubnet });
      throw new Error("expected resolveTlsSettings to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(TlsConfigError);
      expect((error as TlsConfigError).message.length).toBeGreaterThan(0);
    }
  });

  it("accepts internal/acme issuers and defaults unset/blank to internal", () => {
    expect(
      resolveTlsSettings({ host: "jarvis.lan", issuer: undefined, dockerSubnet })?.issuer
    ).toBe("internal");
    expect(resolveTlsSettings({ host: "jarvis.lan", issuer: "  ", dockerSubnet })?.issuer).toBe(
      "internal"
    );
  });

  it("rejects an issuer that isn't exactly internal or acme", () => {
    for (const issuer of ["Internal", "ACME", "letsencrypt", "internal,acme"]) {
      expect(() => resolveTlsSettings({ host: "jarvis.lan", issuer, dockerSubnet })).toThrow(
        TlsConfigError
      );
    }
  });
});

describe("deriveCaddyProxyIp (#1505)", () => {
  it("returns the last usable address of the default subnet", () => {
    expect(deriveCaddyProxyIp("10.251.0.0/24")).toBe("10.251.0.254");
  });

  it("returns the last usable address of a non-default /24 subnet", () => {
    expect(deriveCaddyProxyIp("10.42.0.0/24")).toBe("10.42.0.254");
  });

  it("returns the last usable address of a /16 subnet", () => {
    expect(deriveCaddyProxyIp("172.30.0.0/16")).toBe("172.30.255.254");
  });

  it("rejects a non-CIDR string, missing prefix, IPv6 CIDR, and an unusable /32", () => {
    for (const value of ["not-a-cidr", "10.251.0.0", "fd00::/64", "10.251.0.0/32"]) {
      expect(() => deriveCaddyProxyIp(value)).toThrow(TlsConfigError);
    }
  });
});

describe("setup-prod.ts subprocess (#1505)", () => {
  const scriptPath = new URL("../../scripts/setup-prod.ts", import.meta.url).pathname;
  const repoRoot = new URL("../..", import.meta.url).pathname;

  function runSetup(outDir: string, env: Record<string, string | undefined>) {
    try {
      const stdout = execFileSync("pnpm", ["exec", "tsx", scriptPath, outDir], {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      return { exitCode: 0, stdout };
    } catch (error) {
      const err = error as { status: number | null; stdout?: string; stderr?: string };
      return { exitCode: err.status ?? 1, stdout: (err.stdout ?? "") + (err.stderr ?? "") };
    }
  }

  it("S1: valid TLS input writes the TLS block and leaves the base URL independent", () => {
    const outDir = mkdtempSync(join(tmpdir(), "setup-prod-tls-"));
    try {
      const result = runSetup(outDir, {
        JARVIS_TLS_HOST: "jarvis.lan",
        JARVIS_TLS_ISSUER: "internal",
        JARVIS_DOCKER_SUBNET: undefined
      });
      expect(result.exitCode).toBe(0);
      const content = readFileSync(join(outDir, "env.production.local"), "utf8");
      expect(content).toContain("JARVIS_TLS_HOST=jarvis.lan");
      expect(content).toContain("JARVIS_TLS_ISSUER=internal");
      expect(content).toContain("MOSS_TRUST_PROXY=10.251.0.254");
      const originsLine = content
        .split("\n")
        .find((line) => line.startsWith("MOSS_AUTH_TRUSTED_ORIGINS="));
      expect(originsLine?.replace("MOSS_AUTH_TRUSTED_ORIGINS=", "").split(",")).toContain(
        "https://jarvis.lan"
      );
      expect(content).toContain("MOSS_AUTH_BASE_URL=http://localhost:3000");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("S2: invalid input fails before any file exists", () => {
    const outDir = mkdtempSync(join(tmpdir(), "setup-prod-tls-"));
    try {
      const result = runSetup(outDir, {
        JARVIS_TLS_HOST: "192.168.1.50",
        JARVIS_TLS_ISSUER: "acme"
      });
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(join(outDir, "env.production.local"))).toBe(false);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("S3: an existing file is never replaced, even with valid TLS input", () => {
    const outDir = mkdtempSync(join(tmpdir(), "setup-prod-tls-"));
    try {
      const outFile = join(outDir, "env.production.local");
      writeFileSync(outFile, "SENTINEL=1\n");
      const result = runSetup(outDir, {
        JARVIS_TLS_HOST: "jarvis.lan",
        JARVIS_TLS_ISSUER: "internal"
      });
      expect(result.exitCode).not.toBe(0);
      expect(readFileSync(outFile, "utf8")).toBe("SENTINEL=1\n");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("S4: no TLS input keeps today's file shape, with no TLS keys present", () => {
    const outDir = mkdtempSync(join(tmpdir(), "setup-prod-tls-"));
    try {
      const result = runSetup(outDir, {
        JARVIS_TLS_HOST: undefined,
        JARVIS_TLS_ISSUER: undefined
      });
      expect(result.exitCode).toBe(0);
      const content = readFileSync(join(outDir, "env.production.local"), "utf8");
      expect(content).toContain("MOSS_AUTH_TRUSTED_ORIGINS=http://localhost:1533");
      expect(content).toContain("MOSS_AUTH_BASE_URL=http://localhost:3000");
      expect(content).toContain("JARVIS_DOCKER_SUBNET=10.251.0.0/24");
      expect(content).not.toContain("JARVIS_TLS_HOST");
      expect(content).not.toContain("JARVIS_TLS_ISSUER");
      expect(content).not.toContain("MOSS_TRUST_PROXY");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("infra/env.production.example (#1505)", () => {
  it("documents the in-container auth base URL and the TLS block", () => {
    const content = readFileSync(
      new URL("../../infra/env.production.example", import.meta.url),
      "utf8"
    );
    const lines = content.split("\n");
    const baseUrlIndex = lines.findIndex((line) => line.startsWith("JARVIS_AUTH_BASE_URL="));
    expect(baseUrlIndex).toBeGreaterThanOrEqual(0);
    expect(lines[baseUrlIndex]).toBe("JARVIS_AUTH_BASE_URL=http://localhost:3000");
    expect((lines[baseUrlIndex - 1] ?? "") + (lines[baseUrlIndex - 2] ?? "")).toMatch(
      /in-container/i
    );
    expect(content).toContain("JARVIS_TLS_HOST=");
    expect(content).toContain("JARVIS_TLS_ISSUER=");
  });
});
