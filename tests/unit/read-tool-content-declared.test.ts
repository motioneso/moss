import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import type { ModuleAssistantToolManifest, MossModuleManifest } from "@moss/module-sdk";
import {
  assertReadToolContentDeclared,
  getBuiltInModuleManifests
} from "../../packages/module-registry/src/index.js";

import { createExternalToolManifests } from "../../packages/module-registry/src/external/tool-manifests.js";

const manifests = getBuiltInModuleManifests();
const tools = manifests.flatMap((manifest) => manifest.assistantTools ?? []);
const byName = new Map(tools.map((tool) => [tool.name, tool]));

function synthetic(tool: ModuleAssistantToolManifest): MossModuleManifest {
  return {
    id: "content-probe",
    name: "Content probe",
    version: "0.0.0",
    publisher: "test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    assistantTools: [tool]
  };
}

const readProbe: ModuleAssistantToolManifest = {
  name: "content-probe.read",
  description: "Read a synthetic result.",
  permissionId: "content-probe.view",
  risk: "read"
};

// These return public app declarations/source, fixed guidance, a clock, or counts only.
// Everything else can carry stored, source-derived, or model-generated text.
const TRUSTED_READS = [
  "app.findAction",
  "app.getMapSlice",
  "app.readSource",
  "chat.getCurrentTime",
  "connectors.startGoogleGuidance",
  "wellness.medicationAdherence"
];

const OWN_RECORD_WRITES = [
  "briefings.rerun",
  "chat.deleteClassifierShadowRecords",
  "chat.setResponseStyle",
  "commitments.accept",
  "commitments.reject",
  "commitments.snooze",
  "goals.create",
  "memory.forget",
  "memory.remember",
  "news.addExclusion",
  "news.addTopic",
  "news.refreshNews",
  "news.removeSource",
  "news.removeTopic",
  "notes.create",
  "notes.delete",
  "notes.edit",
  "people.acceptMatch",
  "people.rejectMatch",
  "scratchpad.append",
  "settings.locale.setRegionAndDateFormat",
  "settings.locale.setTimezone",
  "settings.notificationPreference.setEnabled",
  "settings.quietHours.set",
  "settings.themeMode.set",
  "settings.undoLast",
  "sports.removeSource",
  "sports.unfollowTeam",
  "tasks.createList",
  "tasks.createTag",
  "tasks.deleteList",
  "tasks.deleteTag",
  "tasks.renameList",
  "tasks.renameTag"
];

describe("built-in tool result content declarations", () => {
  it("classifies every built-in read tool", () => {
    expect(tools.filter((tool) => tool.risk === "read").length).toBeGreaterThan(40);
    expect(() => assertReadToolContentDeclared(manifests)).not.toThrow();
  });

  it("rejects a newly added read tool that omitted its declaration", () => {
    expect(() => assertReadToolContentDeclared([...manifests, synthetic(readProbe)])).toThrow(
      "content-probe.read: read tool must declare content"
    );
  });

  it.each(["read", "write", "destructive"] as const)(
    "rejects a contradictory %s result declaration",
    (risk) => {
      const tool = { ...readProbe, risk, content: "user_authored", externalContent: true } as const;
      expect(() => assertReadToolContentDeclared([synthetic(tool)])).toThrow(
        "content user_authored conflicts with externalContent"
      );
    }
  );

  it("does not require declarations from external module tools", () => {
    expect(() =>
      assertReadToolContentDeclared([synthetic({ ...readProbe, isExternal: true })])
    ).not.toThrow();
  });

  it("never trusts an external module's attempted content exemption", () => {
    // External manifests are JSON, so an undeclared field can arrive despite the SDK type.
    const hostileTool = { ...readProbe, handler: "read", content: "user_authored" as const };
    const [manifest] = createExternalToolManifests(
      [
        {
          id: "content-probe",
          dir: "/modules/content-probe",
          manifestHash: "sha256:probe",
          packageHash: "sha256:probe",
          manifest: {
            schemaVersion: 1,
            id: "content-probe",
            name: "Content probe",
            version: "0.0.0",
            publisher: "test",
            lifecycle: "optional",
            compatibility: { jarv1s: ">=0.0.0" },
            runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
            assistantTools: [hostileTool]
          }
        }
      ],
      async () => ({ data: {} })
    );
    expect(manifest?.assistantTools?.[0]?.isExternal).toBe(true);
    expect(manifest?.assistantTools?.[0]?.content).toBeUndefined();
  });

  it("keeps the trusted read exemption narrow and every other read outside", () => {
    expect(
      tools
        .filter((tool) => tool.risk === "read" && tool.content === "user_authored")
        .map((tool) => tool.name)
        .sort()
    ).toEqual(TRUSTED_READS);
    for (const tool of tools.filter((entry) => entry.risk === "read")) {
      expect(tool.content, tool.name).toBe(
        TRUSTED_READS.includes(tool.name) ? "user_authored" : "outside"
      );
    }
  });

  it.each(OWN_RECORD_WRITES)("does not taint the own-record response from %s", (name) => {
    const tool = byName.get(name);
    expect(tool, name).toBeDefined();
    expect(tool?.risk).not.toBe("read");
    expect(tool?.content, name).toBe("user_authored");
    expect(tool?.externalContent, name).not.toBe(true);
  });

  it.each([
    "settings.weatherLocation.set",
    "people.merge",
    "people.splitIdentity",
    "tasks.update",
    "tasks.updateStatus",
    "news.confirmSource",
    "sports.confirmSource"
  ])("does not exempt source-derived or retained content from %s", (name) => {
    expect(byName.get(name), name).toBeDefined();
    expect(byName.get(name)?.content, name).not.toBe("user_authored");
  });

  it("wires the read declaration assertion into API onReady with built-in manifests", () => {
    const source = ts.createSourceFile(
      "server.ts",
      readFileSync(new URL("../../apps/api/src/server.ts", import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    const readyChecks: string[] = [];
    function visit(node: ts.Node): void {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === "server.addHook" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0]) &&
        node.arguments[0].text === "onReady"
      ) {
        const callback = node.arguments[1];
        if (callback && ts.isArrowFunction(callback) && ts.isBlock(callback.body)) {
          for (const statement of callback.body.statements) {
            if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
              readyChecks.push(statement.expression.getText(source).replace(/\s/g, ""));
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(readyChecks).toContain("assertReadToolContentDeclared(getBuiltInModuleManifests())");
  });
});
