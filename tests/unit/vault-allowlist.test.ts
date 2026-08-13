import { afterEach, describe, expect, it } from "vitest";

import {
  resolveVaultRoots,
  vaultReadOnlyToolPatterns
} from "../../packages/chat/src/live/vault-allowlist.js";

describe("vaultReadOnlyToolPatterns — fail-closed root validation (#634 security fix)", () => {
  const ROOTS_VAR = "JARVIS_NOTES_ROOTS";
  const originalRoots = process.env[ROOTS_VAR];

  afterEach(() => {
    if (originalRoots === undefined) delete process.env[ROOTS_VAR];
    else process.env[ROOTS_VAR] = originalRoots;
  });

  it("ALLOW: emits Read/Glob/Grep for a clean absolute root", () => {
    process.env[ROOTS_VAR] = "/data/external-notes";
    expect(vaultReadOnlyToolPatterns()).toEqual([
      "Read(/data/external-notes/**)",
      "Glob(/data/external-notes/**)",
      "Grep(/data/external-notes/**)"
    ]);
  });

  it("DENY: rejects a root that injects a separate tool grant via ')' + space (Bash escape)", () => {
    process.env[ROOTS_VAR] = "/vault) Bash(*";
    const patterns = vaultReadOnlyToolPatterns();
    expect(patterns).toEqual([]);
    expect(patterns.join(" ")).not.toContain("Bash(");
  });

  it("DENY: rejects a root containing '..' (vault escape)", () => {
    process.env[ROOTS_VAR] = "/data/external-notes/..";
    expect(vaultReadOnlyToolPatterns()).toEqual([]);
  });

  it("DENY: rejects a bare '..' root", () => {
    process.env[ROOTS_VAR] = "..";
    expect(vaultReadOnlyToolPatterns()).toEqual([]);
  });

  it("DENY: rejects a relative (non-absolute) root", () => {
    process.env[ROOTS_VAR] = "data/external-notes";
    expect(vaultReadOnlyToolPatterns()).toEqual([]);
  });

  it("DENY: rejects a root containing an unnormalized double slash", () => {
    process.env[ROOTS_VAR] = "/data//external-notes";
    expect(vaultReadOnlyToolPatterns()).toEqual([]);
  });

  it("DENY: rejects a root containing whitespace without parens", () => {
    process.env[ROOTS_VAR] = "/data/external notes";
    expect(vaultReadOnlyToolPatterns()).toEqual([]);
  });

  it("DENY: rejects a bare '/' root (filesystem-root scope, Pam re-review)", () => {
    process.env[ROOTS_VAR] = "/";
    expect(vaultReadOnlyToolPatterns()).toEqual([]);
  });

  it("mixed input: drops only the malicious entry, keeps the valid one", () => {
    process.env[ROOTS_VAR] = "/data/external-notes,/vault) Bash(*";
    expect(vaultReadOnlyToolPatterns()).toEqual([
      "Read(/data/external-notes/**)",
      "Glob(/data/external-notes/**)",
      "Grep(/data/external-notes/**)"
    ]);
  });
});

describe("resolveVaultRoots — same fail-closed validation, called directly (#1467)", () => {
  const ROOTS_VAR = "JARVIS_NOTES_ROOTS";
  const originalRoots = process.env[ROOTS_VAR];

  afterEach(() => {
    if (originalRoots === undefined) delete process.env[ROOTS_VAR];
    else process.env[ROOTS_VAR] = originalRoots;
  });

  it("ALLOW: returns a clean absolute root", () => {
    process.env[ROOTS_VAR] = "/data/external-notes";
    expect(resolveVaultRoots()).toEqual(["/data/external-notes"]);
  });

  it("DENY: drops a root that injects a separate tool grant via ')' + space (Bash escape)", () => {
    process.env[ROOTS_VAR] = "/vault) Bash(*";
    expect(resolveVaultRoots()).toEqual([]);
  });

  it("DENY: drops a root containing '..' (vault escape)", () => {
    process.env[ROOTS_VAR] = "/data/external-notes/..";
    expect(resolveVaultRoots()).toEqual([]);
  });

  it("DENY: drops a bare '..' root", () => {
    process.env[ROOTS_VAR] = "..";
    expect(resolveVaultRoots()).toEqual([]);
  });

  it("DENY: drops a relative (non-absolute) root", () => {
    process.env[ROOTS_VAR] = "data/external-notes";
    expect(resolveVaultRoots()).toEqual([]);
  });

  it("DENY: drops a root containing an unnormalized double slash", () => {
    process.env[ROOTS_VAR] = "/data//external-notes";
    expect(resolveVaultRoots()).toEqual([]);
  });

  it("DENY: drops a root containing whitespace without parens", () => {
    process.env[ROOTS_VAR] = "/data/external notes";
    expect(resolveVaultRoots()).toEqual([]);
  });

  it("DENY: drops a bare '/' root (filesystem-root scope)", () => {
    process.env[ROOTS_VAR] = "/";
    expect(resolveVaultRoots()).toEqual([]);
  });

  it("mixed input: drops only the malicious entry, keeps the valid one", () => {
    process.env[ROOTS_VAR] = "/data/external-notes,/vault) Bash(*";
    expect(resolveVaultRoots()).toEqual(["/data/external-notes"]);
  });
});
