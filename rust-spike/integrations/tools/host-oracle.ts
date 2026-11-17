/** Runs the old connection view (toDetail) and manifest on fixed rows and either writes or checks
 *  host/manifest.json and fixtures/view-cases.json. The Rust host replays the same cases. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { toDetail } from "../../../packages/integrations/src/discovery.js";
import { integrationsModuleManifest } from "../../../packages/integrations/src/manifest.js";
import {
  emptyPreparationMap,
  parseSortMap,
  withToolSortResults
} from "../../../packages/integrations/src/classifier-settings.js";
import {
  toolRiskInputs,
  toolSortFingerprint
} from "../../../packages/integrations/src/classifier-risk-inputs.js";

const manifestFile = new URL("../host/manifest.json", import.meta.url);
const casesFile = new URL("../fixtures/view-cases.json", import.meta.url);
const NOW = new Date("2026-11-17T12:00:00.000Z");
const at = "2026-11-17T10:00:00.000Z";
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

type Tool = Parameters<typeof toDetail>[1][number];
const mk = (name: string, extra: object = {}): Tool =>
  ({
    name,
    description: `Does ${name}`,
    group: "",
    inputSchema: { type: "object", properties: { id: { type: "string" } } },
    ...extra
  }) as unknown as Tool;
const names = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => mk(`${prefix}_${i}`));

const base = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
  name: "Home",
  kind: "mcp",
  transport: "http",
  url: "https://example.test/mcp",
  credentialPlacement: { type: "bearer" },
  hasCredential: true,
  enabled: true,
  baseUrl: null,
  specPasted: false,
  enabledGroups: [] as string[],
  enabledTools: [] as string[],
  mutedTools: [] as string[],
  unsuppressedTools: [] as string[],
  classifierEnabled: false,
  classifierPreparation: emptyPreparationMap(),
  classifierSort: parseSortMap(null),
  classifierScan: {},
  classifierKeptOutTools: [] as string[],
  discoveredTools: [] as Tool[],
  lastDiscoveryAt: new Date("2026-11-16T09:30:00.000Z"),
  lastError: null as string | null,
  createdAt: new Date("2026-11-16T09:00:00.000Z"),
  updatedAt: new Date("2026-11-16T09:30:00.000Z")
};

function cases() {
  const small = [
    mk("list_orders", { readOnly: true }),
    mk("send_email"),
    mk("delete_order", { destructive: true })
  ];
  const grouped = Array.from({ length: 40 }, (_, i) =>
    mk(`tool_${i}`, { group: i % 7 === 0 ? "Other" : i % 2 ? "Lights" : "Mail" })
  );
  const fp = (t: Tool) => toolSortFingerprint(toolRiskInputs(t));
  const cur = (t: Tool, risk: string) => ({
    toolName: t.name,
    result: {
      status: "current",
      risk,
      readableName: `Name of ${t.name}`,
      sortFingerprint: fp(t),
      sortedAt: at,
      sortMethod: "model",
      sortedBy: { model: "M", provider: "P" }
    }
  });
  const fail = (t: Tool, failure: string, sortedAt = at) => ({
    toolName: t.name,
    result: { status: "failed", failure, sortFingerprint: fp(t), sortedAt }
  });
  const sorted = withToolSortResults(parseSortMap(null), small, [
    cur(small[0]!, "read"),
    cur(small[1]!, "outbound"),
    fail(small[2]!, "error")
  ] as never);
  const noModel = withToolSortResults(
    parseSortMap(null),
    small,
    small.map((t) => fail(t, "no_model")) as never
  );
  const live = withToolSortResults(parseSortMap(null), small, [
    fail(small[0]!, "interrupted", "2026-11-17T11:59:00.000Z"),
    fail(small[1]!, "interrupted", "2026-11-17T08:00:00.000Z")
  ] as never);
  const out: { name: string; row: unknown; modelReady: boolean; expected: unknown }[] = [];
  const add = (name: string, over: object, modelReady = false) => {
    const row = { ...base, ...over };
    const detail = toDetail(row as never, row.discoveredTools, { now: NOW, modelReady });
    const {
      createdAt,
      updatedAt,
      ownerUserId,
      transport,
      classifierScan,
      classifierPreparation,
      ...r
    } = row;
    void createdAt;
    void updatedAt;
    void ownerUserId;
    void transport;
    void classifierScan;
    void classifierPreparation;
    out.push({ name, row: plain(r), modelReady, expected: plain(detail) });
  };
  add("empty", { discoveredTools: [], hasCredential: false, credentialPlacement: null });
  add("small", { discoveredTools: small, enabledTools: ["list_orders"] });
  add("derived_groups", { discoveredTools: names("hass_light", 40).concat(names("mail_msg", 5)) });
  add("explicit_groups", { discoveredTools: grouped, enabledGroups: ["Lights", "Other"] });
  add("classifier_sorted", {
    discoveredTools: small,
    classifierEnabled: true,
    classifierSort: sorted,
    enabledTools: ["list_orders", "send_email", "delete_order"],
    unsuppressedTools: ["send_email"]
  });
  add("kept_out", {
    discoveredTools: small,
    classifierEnabled: true,
    classifierSort: sorted,
    classifierKeptOutTools: ["list_orders"],
    enabledTools: ["list_orders"]
  });
  add("no_model", { discoveredTools: small, classifierEnabled: true, classifierSort: noModel });
  add(
    "no_model_ready",
    { discoveredTools: small, classifierEnabled: true, classifierSort: noModel },
    true
  );
  add("interrupted", { discoveredTools: small, classifierEnabled: true, classifierSort: live });
  add("error_state", {
    discoveredTools: small,
    lastError: "Could not reach the service.",
    enabled: false
  });
  return out;
}

const result = {
  manifest: plain(integrationsModuleManifest),
  cases: cases()
};

if (process.argv[2] === "check") {
  assert.deepEqual(JSON.parse(readFileSync(manifestFile, "utf8")), result.manifest);
  assert.deepEqual(JSON.parse(readFileSync(casesFile, "utf8")), result.cases);
  console.log("host oracle: fixtures match the old code");
} else {
  writeFileSync(manifestFile, JSON.stringify(result.manifest, null, 2) + "\n");
  writeFileSync(casesFile, JSON.stringify(result.cases, null, 1) + "\n");
  console.log(`wrote manifest and ${result.cases.length} view cases`);
}
