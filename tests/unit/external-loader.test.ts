import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getExternalModuleRegistrations } from "@moss/module-registry/node";

let root: string;
let modulesDir: string;

const validManifest = (id: string) =>
  JSON.stringify({
    schemaVersion: 1,
    id,
    name: "Acme Widgets",
    version: "0.1.0",
    publisher: "Acme, Inc.",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.1.0" }
  });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "extmod-loader-"));
  modulesDir = join(root, "modules");
  mkdirSync(modulesDir, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("getExternalModuleRegistrations (#917)", () => {
  it("returns an empty result when the dir does not exist", () => {
    const result = getExternalModuleRegistrations({
      modulesDir: join(root, "nope"),
      coreVersion: "0.1.0"
    });
    expect(result.discoveries).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("discovers a valid module and hashes it", () => {
    const dir = join(modulesDir, "acme-widgets");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "jarvis.module.json"), validManifest("acme-widgets"));

    const result = getExternalModuleRegistrations({ modulesDir, coreVersion: "0.1.0" });
    expect(result.discoveries).toHaveLength(1);
    expect(result.discoveries[0]!.id).toBe("acme-widgets");
    expect(result.discoveries[0]!.manifestHash.startsWith("sha256:")).toBe(true);
    expect(result.discoveries[0]!.packageHash.startsWith("sha256:")).toBe(true);
  });

  it("rejects a worker queue that collides with a platform queue", () => {
    const dir = join(modulesDir, "acme-widgets");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "jarvis.module.json"),
      JSON.stringify({
        ...JSON.parse(validManifest("acme-widgets")),
        runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
        worker: { queues: [{ name: "acme-widgets.sync", handler: "sync" }] }
      })
    );

    const result = getExternalModuleRegistrations({
      modulesDir,
      coreVersion: "0.1.0",
      reservedQueueNames: new Set(["acme-widgets.sync"])
    });
    expect(result.discoveries).toEqual([]);
    expect(result.rejected[0]?.reason).toContain("collides");
  });

  it("rejects a module whose manifest id != directory name", () => {
    const dir = join(modulesDir, "acme-widgets");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "jarvis.module.json"), validManifest("something-else"));

    const result = getExternalModuleRegistrations({ modulesDir, coreVersion: "0.1.0" });
    expect(result.discoveries).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.reason).toContain("directory");
  });

  it("rejects a module with invalid JSON", () => {
    const dir = join(modulesDir, "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "jarvis.module.json"), "{ not json");

    const result = getExternalModuleRegistrations({ modulesDir, coreVersion: "0.1.0" });
    expect(result.discoveries).toEqual([]);
    expect(result.rejected[0]!.reason.toLowerCase()).toContain("json");
  });

  it("rejects a symlinked directory that escapes the modules root", () => {
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "jarvis.module.json"), validManifest("escapee"));
    symlinkSync(outside, join(modulesDir, "escapee"), "dir");

    const result = getExternalModuleRegistrations({ modulesDir, coreVersion: "0.1.0" });
    expect(result.discoveries).toEqual([]);
    expect(result.rejected[0]!.reason.toLowerCase()).toContain("symlink");
  });

  // #917 C1 regression: a dangling symlink makes realpathSync throw ENOENT. Fail-closed
  // means that throw must reject ONLY that entry, never escape and blank the whole set.
  it("rejects (does not throw) a dangling symlink so it can't blank discovery", () => {
    symlinkSync(join(root, "does-not-exist"), join(modulesDir, "acme-widgets"), "dir");

    let result: ReturnType<typeof getExternalModuleRegistrations>;
    expect(() => {
      result = getExternalModuleRegistrations({ modulesDir, coreVersion: "0.1.0" });
    }).not.toThrow();

    expect(result!.discoveries).toEqual([]);
    expect(result!.rejected).toHaveLength(1);
    expect(result!.rejected[0]!.id).toBe("acme-widgets");
    expect(typeof result!.rejected[0]!.reason).toBe("string");
    expect(result!.rejected[0]!.reason.length).toBeGreaterThan(0);

    // #917 SECURITY: the fs-error reject branch must NOT leak the absolute on-disk path.
    // realpathSync throws ENOENT here with the resolved path in its message; the reason
    // that reaches the admin response + logs must carry only the error CODE, never a path.
    const reason = result!.rejected[0]!.reason;
    expect(reason).toContain("acme-widgets"); // keeps the module-id framing
    expect(reason).not.toContain("/"); // no absolute path segment of any kind
    expect(reason).not.toContain(modulesDir); // and specifically not the modules root
    expect(reason).toContain("ENOENT"); // sanitized to the error code
  });

  it("rejects a directory whose name is not a valid module id slug", () => {
    const dir = join(modulesDir, "Acme_Widgets");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "jarvis.module.json"), validManifest("Acme_Widgets"));

    const result = getExternalModuleRegistrations({ modulesDir, coreVersion: "0.1.0" });
    expect(result.discoveries).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.id).toBe("Acme_Widgets");
    expect(result.rejected[0]!.reason).toContain("slug");
  });

  // #1222: a leftover .prev-<id>/.staging-<id> backup dir must never surface as a
  // rejected module in the admin UI — it should be skipped entirely, absent from both
  // discoveries and rejected, same as the distribution layer already treats it (#964).
  it("skips a .prev-<id> backup directory entirely (absent from both discoveries and rejected)", () => {
    const dir = join(modulesDir, ".prev-acme-widgets");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "jarvis.module.json"), validManifest("acme-widgets"));

    const result = getExternalModuleRegistrations({ modulesDir, coreVersion: "0.1.0" });
    expect(result.discoveries).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("skips a plain dot-directory entirely (absent from both discoveries and rejected)", () => {
    mkdirSync(join(modulesDir, ".hidden"), { recursive: true });

    const result = getExternalModuleRegistrations({ modulesDir, coreVersion: "0.1.0" });
    expect(result.discoveries).toEqual([]);
    expect(result.rejected).toEqual([]);
  });

  it("rejects a module directory that is missing its manifest", () => {
    mkdirSync(join(modulesDir, "acme-widgets"), { recursive: true });

    const result = getExternalModuleRegistrations({ modulesDir, coreVersion: "0.1.0" });
    expect(result.discoveries).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.id).toBe("acme-widgets");
    expect(result.rejected[0]!.reason).toContain("jarvis.module.json");
  });

  // #917 SECURITY (Codex re-QA, finding 1): a manifest READ failure (distinct from a JSON
  // parse failure) must sanitize to the error CODE, never the raw fs message that embeds the
  // absolute on-disk path. The dangling-symlink test above only exercises realpathSync; this
  // drives readFileSync itself by making jarvis.module.json a DIRECTORY (→ EISDIR on read),
  // hitting the split read/parse branch that the earlier single-catch loader lacked.
  it("rejects a manifest read failure (EISDIR) without leaking the on-disk path", () => {
    const dir = join(modulesDir, "acme-widgets");
    mkdirSync(dir, { recursive: true });
    // A directory at the manifest path: existsSync passes, realpathSync stays contained, then
    // readFileSync throws EISDIR with the absolute path in its message — which must not escape.
    mkdirSync(join(dir, "jarvis.module.json"), { recursive: true });

    const result = getExternalModuleRegistrations({ modulesDir, coreVersion: "0.1.0" });
    expect(result.discoveries).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.id).toBe("acme-widgets");

    const reason = result.rejected[0]!.reason;
    expect(reason).toContain("acme-widgets"); // keeps the module-id framing
    expect(reason).toContain("EISDIR"); // sanitized to the error code
    expect(reason).not.toContain(modulesDir); // never the absolute modules path
    expect(reason).not.toContain(tmpdir()); // nor any absolute temp path
  });

  // #917 SECURITY (Codex re-QA, finding 2): a symlinked jarvis.module.json whose target escapes
  // the module dir must be rejected BEFORE it is read — readFileSync follows the link. node.ts
  // realpath-checks the manifest path itself, so the escape is caught without a parse attempt.
  it("rejects a symlinked manifest that escapes the module directory", () => {
    const dir = join(modulesDir, "acme-widgets");
    mkdirSync(dir, { recursive: true });
    const outside = join(root, "outside-manifest.json");
    writeFileSync(outside, validManifest("acme-widgets"));
    symlinkSync(outside, join(dir, "jarvis.module.json"), "file");

    const result = getExternalModuleRegistrations({ modulesDir, coreVersion: "0.1.0" });
    expect(result.discoveries).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.id).toBe("acme-widgets");
    const reason = result.rejected[0]!.reason;
    expect(reason.toLowerCase()).toContain("escape");
    expect(reason).not.toContain(root); // no absolute path leak
  });

  // #917 SECURITY (Codex re-QA, finding 2): the package hasher must not follow a symlinked
  // dist/worker.js out of the module dir. hashExternalPackage throws ExternalPackageEscapeError
  // (carrying only the fixed relPath token), which node.ts's outer catch turns into a path-free
  // reject. The manifest is a real contained file so discovery reaches the hash step.
  it("rejects a symlinked worker bundle that escapes the module directory", () => {
    const dir = join(modulesDir, "acme-widgets");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "jarvis.module.json"), validManifest("acme-widgets"));
    const outside = join(root, "outside-worker.js");
    writeFileSync(outside, "module.exports = {};");
    symlinkSync(outside, join(dir, "dist", "worker.js"), "file");

    const result = getExternalModuleRegistrations({ modulesDir, coreVersion: "0.1.0" });
    expect(result.discoveries).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.id).toBe("acme-widgets");
    const reason = result.rejected[0]!.reason;
    expect(reason.toLowerCase()).toContain("escape");
    expect(reason).toContain("dist/worker.js"); // fixed module-relative token, safe to surface
    expect(reason).not.toContain(root); // no absolute path leak
  });

  // #917 SECURITY (Codex re-QA, finding 2): same guard for a symlinked dist/web directory whose
  // real target escapes the module dir — rejected before any file under it is walked or hashed.
  it("rejects a symlinked web bundle dir that escapes the module directory", () => {
    const dir = join(modulesDir, "acme-widgets");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "jarvis.module.json"), validManifest("acme-widgets"));
    const outside = join(root, "outside-web");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "index.html"), "<!doctype html>");
    symlinkSync(outside, join(dir, "dist", "web"), "dir");

    const result = getExternalModuleRegistrations({ modulesDir, coreVersion: "0.1.0" });
    expect(result.discoveries).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.id).toBe("acme-widgets");
    const reason = result.rejected[0]!.reason;
    expect(reason.toLowerCase()).toContain("escape");
    expect(reason).toContain("dist/web"); // fixed module-relative token, safe to surface
    expect(reason).not.toContain(root); // no absolute path leak
  });
});
