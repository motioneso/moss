import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { CliToolsManifest } from "../../scripts/cli-tools-manifest/manifest.js";
import type { PublisherPackage } from "../../scripts/cli-tools-manifest/packages.js";
import { prepare, type Registry } from "../../scripts/cli-tools-manifest/prepare.js";
import { sha512Integrity, type Attestations } from "../../scripts/cli-tools-manifest/trust.js";

const PACKAGES: PublisherPackage[] = [
  {
    toolset: "a",
    role: "cli",
    pkg: "tool-a",
    expectedRepo: "org/tool-a",
    archPackages: ["tool-a-x64"]
  },
  {
    toolset: "a",
    role: "chat-adapter",
    pkg: "adapter-a",
    expectedRepo: "org/adapter-a",
    archPackages: []
  },
  { toolset: "b", role: "cli", pkg: "tool-b", expectedRepo: "org/tool-b", archPackages: [] }
];

const tarballBytes = (name: string, version: string): Buffer =>
  Buffer.from(`tar:${name}@${version}`);
const tarballUrl = (name: string, version: string): string =>
  `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;

function attestationFor(repo: string, name: string, version: string): Attestations {
  const hex = Buffer.from(
    sha512Integrity(tarballBytes(name, version)).replace(/^sha512-/, ""),
    "base64"
  ).toString("hex");
  const statement = {
    subject: [{ digest: { sha512: hex } }],
    predicate: {
      buildDefinition: {
        externalParameters: { workflow: { repository: `https://github.com/${repo}` } }
      }
    }
  };
  return {
    attestations: [
      {
        predicateType: "https://slsa.dev/provenance/v1",
        bundle: {
          dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64") }
        }
      }
    ]
  };
}

interface World {
  versions: Record<string, string[]>;
  attest: (name: string, version: string) => Attestations | null;
  corruptTarball?: (name: string) => boolean;
}

function fakeRegistry(w: World): Registry {
  return {
    async packument(pkg) {
      const versions: Record<string, { dist: { integrity: string } }> = {};
      for (const v of w.versions[pkg] ?? []) {
        versions[v] = { dist: { integrity: sha512Integrity(tarballBytes(pkg, v)) } };
      }
      return { versions };
    },
    async attestations(pkg, version) {
      return w.attest(pkg, version);
    },
    async tarball(url) {
      const m = /registry\.npmjs\.org\/(.+)\/-\/.+-(\d+\.\d+\.\d+)\.tgz$/.exec(url)!;
      if (w.corruptTarball?.(m[1]!)) return Buffer.from("tampered");
      return tarballBytes(m[1]!, m[2]!);
    }
  };
}

const calls: string[][] = [];

/** Writes the lockfile a real `npm install --package-lock-only` would, including arch packages. */
async function fakeNpm(args: readonly string[], cwd: string): Promise<void> {
  calls.push([...args]);
  if (args[0] !== "install") return;
  const [name, version] = [
    args[1]!.slice(0, args[1]!.lastIndexOf("@")),
    args[1]!.slice(args[1]!.lastIndexOf("@") + 1)
  ];
  const entry = (n: string): object => ({
    version,
    resolved: tarballUrl(n, version),
    integrity: sha512Integrity(tarballBytes(n, version))
  });
  const packages: Record<string, object> = { "": {}, [`node_modules/${name}`]: entry(name) };
  if (name === "tool-a") packages["node_modules/tool-a-x64"] = entry("tool-a-x64");
  await writeFile(path.join(cwd, "package-lock.json"), JSON.stringify({ packages }));
}

async function run(
  w: World,
  over: Partial<Parameters<typeof prepare>[0]> = {}
): ReturnType<typeof prepare> {
  calls.length = 0;
  return prepare({
    packages: PACKAGES,
    previous: null,
    registry: fakeRegistry(w),
    runNpm: fakeNpm,
    outDir: await mkdtemp(path.join(tmpdir(), "prep-out-")),
    minMossVersion: "0.2.0",
    ...over
  });
}

const goodWorld = (): World => ({
  versions: {
    "tool-a": ["1.0.0", "1.1.0"],
    "tool-a-x64": ["1.0.0", "1.1.0"],
    "adapter-a": ["2.0.0"],
    "tool-b": ["3.0.0"]
  },
  attest: (name, version) =>
    name.startsWith("tool-a") ? attestationFor("org/tool-a", name, version) : null
});

function previous(aVersion: string): CliToolsManifest {
  return {
    kind: "cli-tools",
    formatVersion: 1,
    issuedAt: "2026-09-01T00:00:00Z",
    sequence: 4,
    provenanceHistory: { "tool-a": { since: "1.0.0" } },
    toolsets: {
      a: {
        minMossVersion: "0.2.0",
        packages: [
          {
            role: "cli",
            pkg: "tool-a",
            version: aVersion,
            lockfile: `a-cli-${aVersion}.json`,
            lockfileSha256: "a".repeat(64),
            provenance: "attested"
          },
          {
            role: "chat-adapter",
            pkg: "adapter-a",
            version: "2.0.0",
            lockfile: "a-adapter-2.0.0.json",
            lockfileSha256: "b".repeat(64),
            provenance: "none"
          }
        ]
      },
      b: {
        minMossVersion: "0.2.0",
        packages: [
          {
            role: "cli",
            pkg: "tool-b",
            version: "3.0.0",
            lockfile: "b-cli-3.0.0.json",
            lockfileSha256: "c".repeat(64),
            provenance: "none"
          }
        ]
      }
    }
  };
}

describe("prepare", () => {
  it("picks the newest version, records provenance and never runs a script", async () => {
    const r = await run(goodWorld());
    const a = r.outcomes.find((o) => o.toolset === "a")!;
    expect(a.status).toBe("updated");
    expect(a.manifestToolset?.packages.map((p) => `${p.pkg}@${p.version}:${p.provenance}`)).toEqual(
      ["tool-a@1.1.0:attested", "adapter-a@2.0.0:none"]
    );
    expect(r.attested).toEqual(
      expect.arrayContaining([
        { pkg: "tool-a", version: "1.1.0" },
        { pkg: "tool-a-x64", version: "1.1.0" }
      ])
    );
    const installs = calls.filter((c) => c[0] === "install" || c[0] === "ci");
    for (const c of installs) expect(c).toContain("--ignore-scripts");
    expect(calls.some((c) => c[0] === "audit" && c[1] === "signatures")).toBe(true);
  });

  it("leaves a toolset alone when nothing is newer", async () => {
    const w = goodWorld();
    w.versions["tool-a"] = ["1.0.0"];
    const r = await run(w, { previous: previous("1.0.0") });
    expect(r.outcomes.map((o) => o.status)).toEqual(["unchanged", "unchanged"]);
  });

  it("carries the unchanged adapter entry over when only the tool moves", async () => {
    const r = await run(goodWorld(), { previous: previous("1.0.0") });
    const a = r.outcomes.find((o) => o.toolset === "a")!;
    const adapter = a.manifestToolset!.packages.find((p) => p.pkg === "adapter-a")!;
    expect(adapter.lockfile).toBe("a-adapter-2.0.0.json");
  });

  it("blocks one toolset without stopping the others", async () => {
    const w = goodWorld();
    w.corruptTarball = (name) => name === "tool-a";
    const r = await run(w);
    expect(r.outcomes.map((o) => `${o.toolset}:${o.status}`)).toEqual(["a:blocked", "b:updated"]);
    expect(r.outcomes[0]!.subject).toEqual({ pkg: "tool-a", version: "1.1.0" });
  });

  it("blocks a release whose provenance names another repository", async () => {
    const w = goodWorld();
    w.attest = (name, version) => attestationFor("evil/tool-a", name, version);
    const r = await run(w);
    expect(r.outcomes[0]!.status).toBe("blocked");
    expect(r.outcomes[0]!.failures.join(" ")).toMatch(/expected org\/tool-a/);
  });

  it("blocks a release that dropped provenance it used to have", async () => {
    const w = goodWorld();
    w.attest = () => null;
    const r = await run(w, { previous: previous("1.0.0") });
    expect(r.outcomes[0]!.status).toBe("blocked");
    expect(r.outcomes[0]!.failures.join(" ")).toMatch(/carried provenance before/);
  });

  it("refuses a manual request older than the published version", async () => {
    const w = goodWorld();
    const r = await run(w, {
      previous: previous("1.1.0"),
      requested: { pkg: "tool-a", version: "1.0.0" }
    });
    expect(r.outcomes[0]!.status).toBe("blocked");
    expect(r.outcomes[0]!.failures.join(" ")).toMatch(/refusing rollback/);
  });

  it("does not move a scheduled run backwards when the newest version disappeared", async () => {
    const w = goodWorld();
    w.versions["tool-a"] = ["1.0.0"];
    const r = await run(w, { previous: previous("1.1.0") });
    expect(r.outcomes[0]!.status).toBe("unchanged");
  });

  describe("aliased platform packages", () => {
    // The real codex tarballs install its platform builds as versions of the package itself.
    const aliasNpm =
      (real: string) =>
      async (args: readonly string[], cwd: string): Promise<void> => {
        calls.push([...args]);
        if (args[0] !== "install") return;
        const version = args[1]!.slice(args[1]!.lastIndexOf("@") + 1);
        const plain = (n: string): object => ({
          version,
          resolved: tarballUrl(n, version),
          integrity: sha512Integrity(tarballBytes(n, version))
        });
        const packages = {
          "": {},
          "node_modules/tool-b": plain("tool-b"),
          "node_modules/tool-a-x64": {
            name: real,
            version,
            resolved: tarballUrl(real, version),
            integrity: sha512Integrity(tarballBytes(real, version))
          }
        };
        await writeFile(path.join(cwd, "package-lock.json"), JSON.stringify({ packages }));
      };
    const only = PACKAGES.filter((p) => p.toolset === "b").map((p) => ({
      ...p,
      archPackages: ["tool-a-x64"]
    }));

    it("accepts an alias that points back at a package the toolset names", async () => {
      const w = goodWorld();
      w.versions["tool-a-x64"] = ["3.0.0"];
      const r = await run(w, { packages: only, runNpm: aliasNpm("tool-b") });
      expect(r.outcomes[0]!.status).toBe("updated");
    });

    it("accepts an alias that points at a package another toolset names", async () => {
      const w = goodWorld();
      w.versions["tool-a"] = ["3.0.0"];
      const adapter = PACKAGES.filter((p) => p.toolset === "b").map((p) => ({
        ...p,
        archPackages: []
      }));
      const both = [...PACKAGES.filter((p) => p.toolset === "a"), ...adapter];
      const r = await run(w, { packages: both, runNpm: aliasNpm("tool-a") });
      const b = r.outcomes.find((o) => o.toolset === "b")!;
      expect(b.failures, b.failures.join("; ")).toEqual([]);
      expect(b.status).toBe("updated");
    });

    it("blocks an alias that points at an unrelated package", async () => {
      const w = goodWorld();
      w.versions["evil-pkg"] = ["3.0.0"];
      const r = await run(w, { packages: only, runNpm: aliasNpm("evil-pkg") });
      expect(r.outcomes[0]!.status).toBe("blocked");
      expect(r.outcomes[0]!.failures.join(" ")).toMatch(/alias for unrelated package evil-pkg/);
    });
  });
});
