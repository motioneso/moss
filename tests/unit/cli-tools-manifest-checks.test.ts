import { describe, expect, it } from "vitest";

import {
  assertArchPackages,
  assertLockfileIntegrity,
  assertPinnedVersion
} from "../../scripts/cli-tools-manifest/lockfile.js";
import {
  checkProvenance,
  checkTarball,
  extendHistory,
  sha512Integrity,
  type Attestations
} from "../../scripts/cli-tools-manifest/trust.js";
import { pickVersion } from "../../scripts/cli-tools-manifest/versions.js";

describe("pickVersion", () => {
  it("skips prereleases and deprecated versions and compares numerically", () => {
    expect(
      pickVersion({
        versions: {
          "1.2.9": {},
          "1.2.10": {},
          "1.3.0-beta.1": {},
          "1.2.11": { deprecated: "bad release" }
        }
      })
    ).toBe("1.2.10");
  });

  it("returns null when nothing qualifies", () => {
    expect(
      pickVersion({ versions: { "1.0.0": { deprecated: "x" }, "2.0.0-rc.1": {} } })
    ).toBeNull();
  });
});

describe("lockfile checks", () => {
  const lock = (packages: object): string => JSON.stringify({ packages: { "": {}, ...packages } });

  it("fails an entry without sha512", () => {
    const raw = lock({ "node_modules/a": { version: "1.0.0", integrity: "sha1-abc" } });
    expect(assertLockfileIntegrity(raw)).toHaveLength(1);
  });

  it("passes when every entry has sha512", () => {
    const raw = lock({ "node_modules/a": { version: "1.0.0", integrity: "sha512-abc" } });
    expect(assertLockfileIntegrity(raw)).toEqual([]);
  });

  it("fails when a per-arch package is missing", () => {
    const raw = lock({ "node_modules/x-linux-x64": { version: "1.0.0", integrity: "sha512-a" } });
    expect(assertArchPackages(raw, ["x-linux-x64", "x-linux-arm64"])).toEqual([
      "per-arch package x-linux-arm64 is missing from the lockfile"
    ]);
  });

  it("fails when the top-level package resolves to another version", () => {
    const raw = lock({ "node_modules/a": { version: "1.0.1", integrity: "sha512-a" } });
    expect(assertPinnedVersion(raw, "a", "1.0.0")).toHaveLength(1);
    expect(assertPinnedVersion(raw, "a", "1.0.1")).toEqual([]);
  });
});

describe("tarball check", () => {
  const bytes = Buffer.from("tarball");
  const good = sha512Integrity(bytes);

  it("passes when both integrities match", () => {
    expect(checkTarball(bytes, good, good)).toEqual([]);
  });

  it("blocks a mismatch with the lockfile", () => {
    expect(checkTarball(bytes, sha512Integrity(Buffer.from("x")), good)).toHaveLength(1);
  });

  it("blocks a mismatch with the registry", () => {
    expect(checkTarball(bytes, good, sha512Integrity(Buffer.from("x")))).toHaveLength(1);
  });
});

function attestation(repo: string, integrity: string): Attestations {
  const hex = Buffer.from(integrity.replace(/^sha512-/, ""), "base64").toString("hex");
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

describe("provenance rules", () => {
  const integrity = sha512Integrity(Buffer.from("tarball"));
  const base = { pkg: "@openai/codex", expectedRepo: "openai/codex", tarballIntegrity: integrity };

  it("accepts a matching attestation", () => {
    const v = checkProvenance({
      ...base,
      attestations: attestation("openai/codex", integrity),
      history: {}
    });
    expect(v).toMatchObject({ ok: true, provenance: "attested" });
  });

  it("blocks an attestation from another repository", () => {
    const v = checkProvenance({
      ...base,
      attestations: attestation("evil/codex", integrity),
      history: {}
    });
    expect(v.ok).toBe(false);
  });

  it("blocks an attestation for different bytes", () => {
    const other = sha512Integrity(Buffer.from("other"));
    const v = checkProvenance({
      ...base,
      attestations: attestation("openai/codex", other),
      history: {}
    });
    expect(v.ok).toBe(false);
  });

  it("blocks a package that carried provenance before and now has none", () => {
    const v = checkProvenance({
      ...base,
      attestations: { attestations: [] },
      history: { "@openai/codex": { since: "0.150.0" } }
    });
    expect(v.ok).toBe(false);
  });

  it("allows a package that never carried provenance, recorded as none", () => {
    const v = checkProvenance({ ...base, attestations: null, history: {} });
    expect(v).toMatchObject({ ok: true, provenance: "none" });
  });

  it("only grows the history and keeps the first version seen", () => {
    const history = { a: { since: "1.0.0" } };
    const next = extendHistory(history, [
      { pkg: "a", version: "2.0.0" },
      { pkg: "b", version: "3.0.0" }
    ]);
    expect(next).toEqual({ a: { since: "1.0.0" }, b: { since: "3.0.0" } });
  });
});
