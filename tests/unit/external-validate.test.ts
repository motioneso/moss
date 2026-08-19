import { describe, expect, it } from "vitest";

import { validateExternalModuleManifest } from "@moss/module-registry";

const base = {
  schemaVersion: 1,
  id: "acme-widgets",
  name: "Acme Widgets",
  version: "0.1.0",
  publisher: "Acme, Inc.",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.1.0" }
};

describe("validateExternalModuleManifest (#917)", () => {
  it("accepts a well-formed metadata-only manifest", () => {
    const result = validateExternalModuleManifest(base, "acme-widgets", "0.1.0");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.id).toBe("acme-widgets");
  });

  it("rejects a non-object", () => {
    const result = validateExternalModuleManifest(null, "acme-widgets");
    expect(result.ok).toBe(false);
  });

  // #917 (spec revision 2026-07-10, PR #924): the on-disk envelope contract version is required
  // and must be exactly the number 1 — a missing or future value fails closed at load.
  it("rejects a missing schemaVersion", () => {
    const { schemaVersion, ...withoutSchemaVersion } = base;
    const result = validateExternalModuleManifest(withoutSchemaVersion, "acme-widgets", "0.1.0");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("schemaVersion");
  });

  it("rejects a future schemaVersion", () => {
    const result = validateExternalModuleManifest(
      { ...base, schemaVersion: 2 },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("schemaVersion");
  });

  it("rejects an id that does not match the directory name", () => {
    const result = validateExternalModuleManifest(base, "other-dir");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("directory");
  });

  it("rejects an id that is not a slug", () => {
    const result = validateExternalModuleManifest({ ...base, id: "Acme_Widgets" }, "Acme_Widgets");
    expect(result.ok).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { publisher, ...withoutPublisher } = base;
    const result = validateExternalModuleManifest(withoutPublisher, "acme-widgets");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("publisher");
  });

  it("rejects an incompatible core-version range", () => {
    const result = validateExternalModuleManifest(
      { ...base, compatibility: { jarv1s: ">=9.9.9" } },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("compatible");
  });

  it("still rejects an executable/surface field that remains forbidden (routes) — the sole fail-closed guard for old cores now that compatibility.jarv1s is not bumped for this ABI addition", () => {
    const result = validateExternalModuleManifest(
      { ...base, routes: [{ path: "/x", handler: "x" }] },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("routes");
  });

  it("accepts a well-formed navigation declaration", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        navigation: [
          { id: "acme-widgets", label: "Widgets", path: "/", icon: "briefcase", order: 5 }
        ]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.navigation).toEqual([
        { id: "acme-widgets", label: "Widgets", path: "/", icon: "briefcase", order: 5 }
      ]);
    }
  });

  it("still accepts a manifest with no navigation block (metadata-only module)", () => {
    const result = validateExternalModuleManifest(base, "acme-widgets", "0.1.0");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.navigation).toBeUndefined();
  });

  it("rejects an id that is not prefixed with the module id (anti-spoof)", () => {
    const result = validateExternalModuleManifest(
      { ...base, navigation: [{ id: "settings", label: "Settings", path: "/" }] },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("navigation entry id");
  });

  it("rejects duplicate navigation ids", () => {
    const entry = { id: "acme-widgets", label: "Widgets", path: "/" };
    const result = validateExternalModuleManifest(
      { ...base, navigation: [entry, entry] },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("unique");
  });

  it("rejects a navigation path that escapes the module (traversal / absolute / host)", () => {
    for (const path of ["..", "/../x", "//evil.com", "/a//b", "/a\\b", "/a?x=1", "/a#frag", "x"]) {
      const result = validateExternalModuleManifest(
        { ...base, navigation: [{ id: "acme-widgets", label: "Widgets", path }] },
        "acme-widgets",
        "0.1.0"
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects zero, more than 4, and unknown-key navigation entries", () => {
    const tooMany = Array.from({ length: 5 }, (_, i) => ({
      id: `acme-widgets.item-${i}`,
      label: `Item ${i}`,
      path: `/item-${i}`
    }));
    for (const navigation of [
      [],
      tooMany,
      [{ id: "acme-widgets", label: "Widgets", path: "/", permissionId: "acme-widgets.x" }]
    ]) {
      const result = validateExternalModuleManifest(
        { ...base, navigation },
        "acme-widgets",
        "0.1.0"
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects an over-long label and an out-of-range order", () => {
    const overLongLabel = { id: "acme-widgets", label: "x".repeat(41), path: "/" };
    const overRangeOrder = { id: "acme-widgets", label: "Widgets", path: "/", order: 10_001 };
    for (const entry of [overLongLabel, overRangeOrder]) {
      const result = validateExternalModuleManifest(
        { ...base, navigation: [entry] },
        "acme-widgets",
        "0.1.0"
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects declared auth in this slice", () => {
    const result = validateExternalModuleManifest(
      { ...base, auth: [{ id: "acme-widgets.key", kind: "api-key", label: "Key" }] },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("auth");
  });

  it("accepts a declared worker tool", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
        assistantTools: [
          {
            name: "acme-widgets.lookup",
            description: "Look up a widget",
            permissionId: "acme-widgets.lookup",
            risk: "read",
            inputSchema: { type: "object" },
            handler: "lookup"
          }
        ]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a declared worker tool with a non-empty actionLabel", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
        assistantTools: [
          {
            name: "acme-widgets.lookup",
            description: "Look up a widget",
            actionLabel: "Look up a widget for you",
            permissionId: "acme-widgets.lookup",
            risk: "read",
            inputSchema: { type: "object" },
            handler: "lookup"
          }
        ]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(true);
  });

  // #1274: an inputSchema.pattern that won't compile currently only fails the first time the
  // tool is actually called (via compilePattern in the gateway). It must be rejected here, at
  // install time, instead of looking accepted until first use.
  it("rejects a declared tool inputSchema pattern that does not compile", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
        assistantTools: [
          {
            name: "acme-widgets.lookup",
            description: "Look up a widget",
            permissionId: "acme-widgets.lookup",
            risk: "read",
            inputSchema: {
              type: "object",
              properties: { key: { type: "string", pattern: "[a-z" } }
            },
            handler: "lookup"
          }
        ]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("pattern");
      expect(result.errors.join(" ")).toContain("[a-z");
    }
  });

  // The bare-probe step of compilePattern is what catches this: "[a-z]+)|(.*" throws
  // Unmatched ')' when compiled unanchored, even though the anchored/wrapped form alone would
  // not have caught it. The install-time lint must run the same bare-probe-then-anchored check,
  // not just the anchored one.
  it("rejects a declared tool inputSchema pattern that only the bare-probe compile step catches", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
        assistantTools: [
          {
            name: "acme-widgets.lookup",
            description: "Look up a widget",
            permissionId: "acme-widgets.lookup",
            risk: "read",
            inputSchema: {
              type: "object",
              properties: { key: { type: "string", pattern: "[a-z]+)|(.*" } }
            },
            handler: "lookup"
          }
        ]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("pattern");
  });

  it("accepts a declared tool inputSchema pattern that compiles", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
        assistantTools: [
          {
            name: "acme-widgets.lookup",
            description: "Look up a widget",
            permissionId: "acme-widgets.lookup",
            risk: "read",
            inputSchema: {
              type: "object",
              properties: { key: { type: "string", pattern: "[a-z]+" } }
            },
            handler: "lookup"
          }
        ]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(true);
  });

  it("rejects a declared tool inputSchema pattern nested under array items", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
        assistantTools: [
          {
            name: "acme-widgets.lookup",
            description: "Look up a widget",
            permissionId: "acme-widgets.lookup",
            risk: "read",
            inputSchema: {
              type: "object",
              properties: {
                keys: { type: "array", items: { type: "string", pattern: "(" } }
              }
            },
            handler: "lookup"
          }
        ]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("pattern");
  });

  it("rejects a declared actionLabel that is an empty string", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
        assistantTools: [
          {
            name: "acme-widgets.lookup",
            description: "Look up a widget",
            actionLabel: "",
            permissionId: "acme-widgets.lookup",
            risk: "read",
            inputSchema: { type: "object" },
            handler: "lookup"
          }
        ]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("actionLabel");
  });

  it("rejects a declared actionLabel that is not a string", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
        assistantTools: [
          {
            name: "acme-widgets.lookup",
            description: "Look up a widget",
            actionLabel: 42,
            permissionId: "acme-widgets.lookup",
            risk: "read",
            inputSchema: { type: "object" },
            handler: "lookup"
          }
        ]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("actionLabel");
  });

  it("rejects every forbidden control character in a declared actionLabel", () => {
    for (const codePoint of [...Array.from({ length: 32 }, (_, index) => index), 0x7f]) {
      const result = validateExternalModuleManifest(
        {
          ...base,
          runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
          assistantTools: [
            {
              name: "acme-widgets.lookup",
              description: "Look up a widget",
              actionLabel: `Look up${String.fromCharCode(codePoint)}now`,
              permissionId: "acme-widgets.lookup",
              risk: "read",
              inputSchema: { type: "object" },
              handler: "lookup"
            }
          ]
        },
        "acme-widgets",
        "0.1.0"
      );
      expect(result.ok, `control U+${codePoint.toString(16).padStart(4, "0")}`).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("actionLabel");
    }
  });

  it("accepts 80 UTF-16 code units in actionLabel and rejects 81", () => {
    const validateLabel = (actionLabel: string) =>
      validateExternalModuleManifest(
        {
          ...base,
          runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
          assistantTools: [
            {
              name: "acme-widgets.lookup",
              description: "Look up a widget",
              actionLabel,
              permissionId: "acme-widgets.lookup",
              risk: "read",
              inputSchema: { type: "object" },
              handler: "lookup"
            }
          ]
        },
        "acme-widgets",
        "0.1.0"
      );

    expect(validateLabel("x".repeat(80)).ok).toBe(true);
    const overLimit = validateLabel("x".repeat(81));
    expect(overLimit.ok).toBe(false);
    if (!overLimit.ok) expect(overLimit.errors.join(" ")).toContain("actionLabel");
  });

  it("rejects tools without a compatible worker", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        assistantTools: [
          {
            name: "acme-widgets.lookup",
            description: "Look up a widget",
            permissionId: "acme-widgets.lookup",
            risk: "read",
            handler: "lookup"
          }
        ]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("runtime");
  });

  it("rejects a worker entrypoint outside the package hash", () => {
    const result = validateExternalModuleManifest(
      { ...base, runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 } },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("dist/worker.js");
  });

  it("rejects unprefixed and duplicate worker tools", () => {
    const tool = {
      name: "lookup",
      description: "Look up a widget",
      permissionId: "lookup",
      risk: "read",
      handler: "lookup"
    };
    const result = validateExternalModuleManifest(
      {
        ...base,
        runtime: { workerEntrypoint: "../worker.js", workerContractVersion: 2 },
        assistantTools: [tool, tool]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const errors = result.errors.join(" ");
      expect(errors).toContain("workerEntrypoint");
      expect(errors).toContain("workerContractVersion");
      expect(errors).toContain("prefixed");
      expect(errors).toContain("unique");
    }
  });
  // FIN-00 #1145: instanceWritePolicy is only meaningful (and only admin-approved)
  // for namespaces that actually carry instance scope, and only two values exist.
  it("accepts instanceWritePolicy 'module' on an instance-scoped namespace", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        storage: [
          { namespace: "acme-widgets.state", scopes: ["instance"], instanceWritePolicy: "module" }
        ]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(true);
  });

  it("rejects instanceWritePolicy on a user-only namespace", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        storage: [
          { namespace: "acme-widgets.state", scopes: ["user"], instanceWritePolicy: "module" }
        ]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("instanceWritePolicy");
  });

  it("rejects unknown instanceWritePolicy values", () => {
    const result = validateExternalModuleManifest(
      {
        ...base,
        storage: [
          { namespace: "acme-widgets.state", scopes: ["instance"], instanceWritePolicy: "always" }
        ]
      },
      "acme-widgets",
      "0.1.0"
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("instanceWritePolicy");
  });

  // #1725: `preferences` is the narrow replacement for the still-forbidden `settings` field.
  // An installed module declares switches; the host owns the page and the write path. Every
  // rejection below names its own error text, so a validator that skipped the check would fail
  // the assertion rather than pass on a coincidental error from another rule.
  describe("preferences (#1725)", () => {
    const pref = {
      key: "aiEstimates",
      label: "AI nutrition estimates",
      description: "Let Moss estimate calories for meals you log.",
      type: "boolean",
      default: true
    };

    it("accepts a well-formed preferences declaration", () => {
      const result = validateExternalModuleManifest(
        { ...base, preferences: [pref] },
        "acme-widgets",
        "0.1.0"
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.manifest.preferences).toEqual([pref]);
    });

    it("accepts a manifest with no preferences block", () => {
      const result = validateExternalModuleManifest(base, "acme-widgets", "0.1.0");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.manifest.preferences).toBeUndefined();
    });

    it("still rejects the built-in `settings` field", () => {
      const result = validateExternalModuleManifest(
        { ...base, settings: [{ id: "x", label: "X", path: "/settings/x" }] },
        "acme-widgets",
        "0.1.0"
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("settings");
    });

    it("rejects more than 8 preferences", () => {
      const many = Array.from({ length: 9 }, (_, i) => ({ ...pref, key: `pref${i}` }));
      const result = validateExternalModuleManifest(
        { ...base, preferences: many },
        "acme-widgets",
        "0.1.0"
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("at most 8");
    });

    it("rejects a duplicate key", () => {
      const result = validateExternalModuleManifest(
        { ...base, preferences: [pref, { ...pref, label: "Other" }] },
        "acme-widgets",
        "0.1.0"
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("unique");
    });

    it("rejects a key that is not a lower camel-case identifier", () => {
      for (const key of ["AiEstimates", "ai-estimates", "1estimates", ""]) {
        const result = validateExternalModuleManifest(
          { ...base, preferences: [{ ...pref, key }] },
          "acme-widgets",
          "0.1.0"
        );
        expect(result.ok, `key ${JSON.stringify(key)} must be rejected`).toBe(false);
        if (!result.ok) expect(result.errors.join(" ")).toContain("preference key");
      }
    });

    it("rejects a non-boolean type", () => {
      const result = validateExternalModuleManifest(
        { ...base, preferences: [{ ...pref, type: "number", default: 3 }] },
        "acme-widgets",
        "0.1.0"
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("preference type");
    });

    it("rejects a default whose type does not match", () => {
      const result = validateExternalModuleManifest(
        { ...base, preferences: [{ ...pref, default: "yes" }] },
        "acme-widgets",
        "0.1.0"
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("preference default");
    });

    it("rejects a missing default", () => {
      const { default: _omitted, ...withoutDefault } = pref;
      const result = validateExternalModuleManifest(
        { ...base, preferences: [withoutDefault] },
        "acme-widgets",
        "0.1.0"
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("preference default");
    });

    it("rejects unknown fields rather than dropping them", () => {
      const result = validateExternalModuleManifest(
        { ...base, preferences: [{ ...pref, permissionId: "acme.manage" }] },
        "acme-widgets",
        "0.1.0"
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join(" ")).toContain("unknown fields");
    });

    it("rejects an over-long label or description", () => {
      const longLabel = validateExternalModuleManifest(
        { ...base, preferences: [{ ...pref, label: "x".repeat(61) }] },
        "acme-widgets",
        "0.1.0"
      );
      expect(longLabel.ok).toBe(false);
      if (!longLabel.ok) expect(longLabel.errors.join(" ")).toContain("preference label");

      const longDescription = validateExternalModuleManifest(
        { ...base, preferences: [{ ...pref, description: "x".repeat(161) }] },
        "acme-widgets",
        "0.1.0"
      );
      expect(longDescription.ok).toBe(false);
      if (!longDescription.ok)
        expect(longDescription.errors.join(" ")).toContain("preference description");
    });
  });
});
