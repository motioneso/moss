/** Runs the old sorting code (real fingerprint, reduction, credential check, planning, answer
 *  reading, sort map and free names) on fixed tools and either writes or checks
 *  fixtures/sorting-cases.json. The Rust crate replays the same cases. No database. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildSortingPrompt,
  buildSortingToolPayload,
  credentialMatcher,
  failedSortResults,
  parseSortingAnswer,
  planSortingCalls,
  reduceSortingInputSchema,
  resultsWithoutCall,
  sortingCallPrompt,
  sortingTargets,
  sortedToolRisk
} from "../../../packages/integrations/src/classifier-sorting.js";
import { readableToolNames } from "../../../packages/integrations/src/classifier-readable-name.js";
import {
  parseSortMap,
  toolRunsWithoutAsking,
  toolSortState,
  withSendWithoutAsking,
  withToolSortResults,
  withoutStaleSendChoices,
  type ClassifierSortMap
} from "../../../packages/integrations/src/classifier-settings.js";
import {
  toolRiskInputs,
  toolSortFingerprint
} from "../../../packages/integrations/src/classifier-risk-inputs.js";
import { attemptLive } from "../../../packages/integrations/src/classifier-attempt.js";
import type { DiscoveredTool } from "../../../packages/integrations/src/openapi-convert.js";

const file = new URL("../fixtures/sorting-cases.json", import.meta.url);
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {})
});
const big = "x".repeat(9000);
const tools: DiscoveredTool[] = [
  {
    name: "HassTurnOn",
    description: "Turns on a device",
    group: "",
    inputSchema: obj({ name: { type: "string", description: "Device name", default: "lamp" } })
  },
  {
    name: "HassTurnOff",
    description: "Turns off a device",
    group: "",
    inputSchema: obj({ name: { type: "string" } }),
    readOnly: false
  },
  {
    name: "HassLightSet",
    description: "Sets a light",
    group: "",
    inputSchema: obj(
      {
        brightness: { type: ["integer", "null"], enum: [1, 2] },
        color: {
          anyOf: [
            { type: "string", pattern: "^#" },
            { type: "array", items: { type: "number" } }
          ]
        }
      },
      ["brightness", "ignored", 5 as never]
    ),
    idempotent: true
  },
  {
    name: "intent_script__AddTaskWork",
    description: "Adds work to a task",
    group: "",
    inputSchema: null
  },
  { name: "intent_script__AddShowWork", description: "Adds a show", group: "", inputSchema: null },
  {
    name: "list_orders",
    description: "Lists orders",
    group: "orders",
    inputSchema: obj({ page: { type: "integer" } }),
    readOnly: true
  },
  {
    name: "delete_order",
    description: "Deletes an order",
    group: "orders",
    inputSchema: obj({ id: { type: "string" } }),
    destructive: true
  },
  {
    name: "send_email",
    description: "Sends an email to a person",
    group: "mail",
    inputSchema: obj({ to: { type: "string" }, body: { type: "string" } }, ["to"])
  },
  {
    name: "getApiV3Movies",
    description: "Lists movies",
    group: "movies",
    inputSchema: obj({ q: { type: "string" }, "X-Api-Key": { type: "string" } }, [
      "X-Api-Key",
      "q"
    ]),
    invoke: {
      method: "GET",
      path: "/api/v3/movies",
      params: [
        { name: "q", in: "query" },
        { name: "X-Api-Key", in: "header" }
      ],
      hasBody: false
    }
  },
  {
    name: "get_api_v3_movies",
    description: "Looks up movies by route",
    group: "movies",
    inputSchema: obj({}),
    invoke: { method: "get", path: "/api/v3/movies", params: [], hasBody: false }
  },
  {
    name: "delete_api_v3_movies_id",
    description: "Remove a movie",
    group: "movies",
    inputSchema: obj({ id: { type: "integer" } }),
    invoke: {
      method: "delete",
      path: "/api/v3/movies/{id}",
      params: [{ name: "id", in: "path" }],
      hasBody: false
    }
  },
  {
    name: "post_api_v3_series",
    description: "Add a series",
    group: "series",
    inputSchema: obj({ title: { type: "string" } }),
    invoke: { method: "post", path: "/api/v3/series", params: [], hasBody: true }
  },
  { name: "huge_tool", description: big, group: "", inputSchema: null },
  {
    name: "leaky_plain",
    description: "Use token SECRET-KEY-123 to call",
    group: "",
    inputSchema: null
  },
  {
    name: "leaky_b64",
    description: `Auth ${Buffer.from("SECRET-KEY-123").toString("base64")}`,
    group: "",
    inputSchema: null
  },
  {
    name: "leaky_b64url",
    description: `Auth ${Buffer.from("SECRET-KEY-123").toString("base64url")}`,
    group: "",
    inputSchema: null
  },
  {
    name: "leaky_key",
    description: "ok",
    group: "",
    inputSchema: obj({ "SECRET-KEY-123": { type: "string" } })
  },
  { name: "leaky_url", description: "see %53ecret%20x", group: "", inputSchema: null },
  {
    name: "deep",
    description: "Deeply nested",
    group: "",
    inputSchema: JSON.parse(
      '{"type":"object","properties":{"a":{"type":"object","properties":{"b":{"type":"object","properties":{"c":{"type":"object","properties":{"d":{"type":"object","properties":{"e":{"type":"object","properties":{"f":{"type":"object","properties":{"g":{"type":"object","properties":{"h":{"type":"object","properties":{"i":{"type":"string","description":"too deep"}}}}}}}}}}}}}}}}}}}'
    )
  },
  {
    name: "ünï_tool Ω",
    description: "Unicode ✓ name",
    group: "g",
    inputSchema: obj({ ключ: { type: "string", description: "описание" } })
  },
  { name: "Reset", description: "", group: "", inputSchema: null }
];
for (const t of tools)
  if (t.name === "get_api_v3_movies") (t as { name: string }).name = "get_api_v3_movies";

const credentials = [null, "", "SECRET-KEY-123", "sp ace&+/=é", "Bearer abc.def"];
const texts = [
  "nothing",
  "SECRET-KEY-123",
  "xx SECRET-KEY-123 yy",
  "U0VDUkVULUtFWS0xMjM=",
  "U0VDUkVULUtFWS0xMjM",
  "sp%20ace%26%2B%2F%3D%C3%A9",
  "sp+ace%26%2B%2F%3D%C3%A9",
  "SP%20ACE%26%2b%2f%3d%c3%a9",
  "sp%20ace&+/=%C3%A9",
  "sp ace&+/=é",
  "c3AgYWNlJisvPcOp",
  "Bearer abc.def",
  "bearer abc.def"
];

function sortMapCases() {
  const first = (n: string) => tools.find((t) => t.name === n)!;
  const fp = (n: string) =>
    tools.some((t) => t.name === n)
      ? toolSortFingerprint(toolRiskInputs(first(n)))
      : "sha256:missing";
  const at = "2026-11-17T10:00:00.000Z";
  const cur = (n: string, risk: string, extra: object = {}) => ({
    toolName: n,
    result: {
      status: "current",
      risk,
      readableName: `Name of ${n}`,
      sortFingerprint: fp(n),
      sortedAt: at,
      sortMethod: "model",
      sortedBy: { model: "M", provider: "P" },
      ...extra
    }
  });
  const fail = (n: string, failure: string, sortFingerprint = fp(n)) => ({
    toolName: n,
    result: { status: "failed", failure, sortFingerprint, sortedAt: at }
  });
  const steps: unknown[] = [
    {
      op: "results",
      results: [
        cur("HassTurnOn", "write"),
        cur("send_email", "outbound"),
        cur("delete_order", "destructive"),
        cur("list_orders", "read"),
        fail("HassTurnOff", "error"),
        fail("HassLightSet", "interrupted"),
        cur("deep", "read", { readableName: "x".repeat(81) }),
        cur("Reset", "read", { sortFingerprint: "sha256:other" }),
        cur("ünï_tool Ω", "write", { sortMethod: "local" }),
        cur("not_a_tool", "read")
      ]
    },
    { op: "send", tool: "send_email", allow: true },
    { op: "send", tool: "HassTurnOn", allow: true },
    { op: "send", tool: "list_orders", allow: false },
    {
      op: "results",
      results: [cur("send_email", "outbound", { sortedAt: "2026-11-17T11:00:00.000Z" })]
    },
    { op: "results", results: [fail("send_email", "no_model")] },
    {
      op: "results",
      results: [
        fail("HassTurnOff", "no_model"),
        fail("HassLightSet", "no_model"),
        fail("Reset", "no_model")
      ]
    },
    { op: "results", results: [fail("HassTurnOff", "no_model")] },
    { op: "send", tool: "send_email", allow: true },
    {
      op: "results",
      results: [
        {
          toolName: "send_email",
          result: { ...cur("send_email", "outbound").result, sortFingerprint: "sha256:changed" }
        }
      ]
    },
    {
      op: "stale",
      tools: tools.map((t) => (t.name === "send_email" ? { ...t, description: "changed" } : t))
    },
    { op: "results", results: [cur("send_email", "outbound")] },
    { op: "send", tool: "send_email", allow: true },
    { op: "stale", tools: tools.filter((t) => t.name !== "send_email") }
  ];
  let map: ClassifierSortMap = parseSortMap(null);
  const out: unknown[] = [];
  for (const step of steps as { op: string; [k: string]: unknown }[]) {
    let result: unknown = null;
    if (step.op === "results") map = withToolSortResults(map, tools, step.results as never);
    else if (step.op === "send") {
      const next = withSendWithoutAsking(map, first(step.tool as string), step.allow as boolean);
      result = next === null ? "refused" : "ok";
      if (next) map = next;
    } else map = withoutStaleSendChoices(map, step.tools as never);
    out.push({
      step,
      result,
      map: plain(map),
      states: Object.fromEntries(
        tools.map((t) => [
          t.name,
          { state: plain(toolSortState(map, t)), runs: toolRunsWithoutAsking(map, t) }
        ])
      )
    });
  }
  const garbage = [
    null,
    5,
    { version: 2, entries: {} },
    { version: 1, entries: 3 },
    {
      version: 1,
      entries: {
        a: null,
        b: { status: "current" },
        c: { status: "failed", sortFingerprint: "f", sortedAt: "t", failure: "bogus" },
        d: { status: "never_tried" },
        e: {
          status: "current",
          risk: "read",
          readableName: "N",
          sortFingerprint: "f",
          sortedAt: "t",
          sendWithoutAsking: true,
          legacyRiskFloor: "outbound",
          sortedBy: { model: "m", provider: "" }
        },
        f: {
          status: "failed",
          sortFingerprint: "f",
          sortedAt: "t",
          failure: "unsafe",
          legacyRiskFloor: "bad"
        }
      }
    }
  ];
  return {
    steps: out,
    garbage: garbage.map((g) => ({ input: g, parsed: plain(parseSortMap(g)) }))
  };
}

function build() {
  const matcherCases = credentials.map((credential) => {
    const m = credentialMatcher(credential);
    return { credential, results: texts.map((t) => m.contains(t)) };
  });
  const plans = [null, "SECRET-KEY-123", "sp ace&+/=é"].map((credential) => {
    const plan = planSortingCalls(tools, credentialMatcher(credential));
    return {
      credential,
      unsafe: plan.unsafe.map((t) => t.name),
      oversized: plan.oversized.map((t) => t.name),
      calls: plan.calls.map((call) => ({
        ids: call.map((c) => c.id),
        names: call.map((c) => c.tool.name),
        serialized: call.map((c) => c.serialized),
        promptSha: sha(sortingCallPrompt(call)),
        promptLen: Buffer.byteLength(sortingCallPrompt(call))
      }))
    };
  });
  const many = Array.from(
    { length: 70 },
    (_, i) =>
      ({
        name: `bulk_tool_${i}`,
        description: `Tool ${i}`,
        group: "",
        inputSchema: null
      }) as DiscoveredTool
  );
  const manyPlan = planSortingCalls(many, credentialMatcher(null));
  const wide = Array.from(
    { length: 20 },
    (_, i) =>
      ({
        name: `wide_${i}`,
        description: "d".repeat(7800),
        group: "",
        inputSchema: null
      }) as DiscoveredTool
  );
  const widePlan = planSortingCalls(wide, credentialMatcher(null));
  const answers = [
    {
      tools: [
        { id: "t1", group: "changes_things", name: "  Turn on  " },
        { id: "t2", group: "sensitive", name: "Delete" }
      ]
    },
    {
      tools: [
        { id: "t1", group: "looks_things_up", name: "A" },
        { id: "t1", group: "looks_things_up", name: "B" },
        { id: "t1", group: "looks_things_up", name: "C" }
      ]
    },
    {
      tools: [
        { id: "t1", group: "bogus", name: "A" },
        { id: "t2", group: "changes_things", name: "" },
        { id: "t3", group: "changes_things", name: "ok", extra: 1 },
        { id: "zz", group: "changes_things", name: "ok" },
        { id: "t4", group: "sends_things_out", name: "x".repeat(81) },
        { id: "t5", group: "sends_things_out", name: "bad\nname" },
        7,
        null,
        { id: 3 }
      ]
    },
    {
      tools: [
        { id: "t1", group: "sends_things_out", name: 5 },
        { id: "t2", group: 5, name: "n" }
      ]
    },
    { tools: "no" },
    null,
    [],
    "text"
  ];
  const ids = ["t1", "t2", "t3", "t4", "t5"];
  const sm = sortMapCases();
  const targets = [
    { sort: parseSortMap(null), retryFailed: false, retryNoModel: false },
    ...[false, true].flatMap((retryFailed) =>
      [false, true].map((retryNoModel) => ({ sort: sm.steps.at(6)!, retryFailed, retryNoModel }))
    )
  ].map((c, i) => {
    const sort: ClassifierSortMap =
      i === 0 ? (c.sort as ClassifierSortMap) : parseSortMap((c.sort as { map: unknown }).map);
    const picked = sortingTargets({
      discoveredTools: tools,
      sort,
      retryFailed: c.retryFailed,
      retryNoModel: c.retryNoModel,
      now: new Date(NOW)
    });
    return {
      index: i,
      retryFailed: c.retryFailed,
      retryNoModel: c.retryNoModel,
      map: plain(sort),
      names: picked.map((t) => t.name)
    };
  });
  const liveSort = parseSortMap({
    version: 1,
    entries: {
      HassTurnOn: {
        status: "failed",
        failure: "interrupted",
        sortFingerprint: toolSortFingerprint(toolRiskInputs(tools[0]!)),
        sortedAt: "2026-11-17T11:50:00.000Z"
      },
      HassTurnOff: {
        status: "failed",
        failure: "interrupted",
        sortFingerprint: toolSortFingerprint(toolRiskInputs(tools[1]!)),
        sortedAt: "2026-11-17T11:00:00.000Z"
      }
    }
  });
  const live = sortingTargets({
    discoveredTools: tools.slice(0, 2),
    sort: liveSort,
    retryFailed: true,
    now: new Date(NOW)
  }).map((t) => t.name);
  const attempts = [
    "2026-11-17T11:30:00.001Z",
    "2026-11-17T11:30:00.000Z",
    "2026-11-17T11:29:59.999Z",
    "2026-11-17T11:50:00Z",
    "nonsense",
    "2026-11-17"
  ].map((s) => ({ startedAt: s, live: attemptLive(s, new Date(NOW)) }));
  const free = readableToolNames(tools);
  const resultsNoCall = resultsWithoutCall(
    planSortingCalls(tools, credentialMatcher("SECRET-KEY-123")),
    free,
    "2026-11-17T12:00:00.000Z"
  );
  return {
    now: NOW,
    tools,
    fingerprints: Object.fromEntries(
      tools.map((t) => [t.name, toolSortFingerprint(toolRiskInputs(t))])
    ),
    riskInputs: Object.fromEntries(tools.map((t) => [t.name, plain(toolRiskInputs(t))])),
    payloads: Object.fromEntries(
      tools.map((t) => [t.name, JSON.stringify(buildSortingToolPayload(t, "t1"))])
    ),
    reduced: Object.fromEntries(
      tools.map((t) => [
        t.name,
        JSON.stringify(
          reduceSortingInputSchema(
            t.inputSchema,
            new Set((t.invoke?.params ?? []).filter((p) => p.in === "header").map((p) => p.name))
          )
        )
      ])
    ),
    risks: Object.fromEntries(
      tools.map((t) => [
        t.name,
        ["looks_things_up", "changes_things", "sends_things_out", "sensitive", null].map((g) =>
          sortedToolRisk(g as never, toolRiskInputs(t))
        )
      ])
    ),
    freeNames: plain(Object.fromEntries(free)),
    freeNameSets: [[0, 1, 2], [3, 4], [8, 9, 10, 11], [5, 6, 7], [12], []].map((idx) => ({
      idx,
      names: plain(Object.fromEntries(readableToolNames(idx.map((i) => tools[i]!))))
    })),
    emptyPrompt: {
      sha: sha(buildSortingPrompt("[]")),
      len: Buffer.byteLength(buildSortingPrompt("[]"))
    },
    matcher: { texts, cases: matcherCases },
    plans,
    manyPlan: manyPlan.calls.map((c) => c.map((e) => e.id).join(",")),
    widePlan: { calls: widePlan.calls.map((c) => c.length), oversized: widePlan.oversized.length },
    answers: answers.map((raw) => ({
      raw,
      ids,
      parsed: plain(Object.fromEntries(parseSortingAnswer(raw, ids)))
    })),
    targets,
    liveTargets: live,
    attempts,
    resultsWithoutCall: plain(resultsNoCall),
    failedResults: plain(
      failedSortResults(tools.slice(0, 2), "no_model", "2026-11-17T12:00:00.000Z")
    ),
    sortMap: sm
  };
}

const built = build();
if (process.argv[2] === "check") {
  assert.deepEqual(
    JSON.parse(readFileSync(file, "utf8")),
    plain(built),
    "fixtures differ from the old code"
  );
  console.log("sorting fixtures match the old code");
} else {
  writeFileSync(file, `${JSON.stringify(plain(built))}\n`);
  console.log("wrote", file.pathname);
}
