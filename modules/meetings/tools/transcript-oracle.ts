/** Runs the old transcript and History routes against a real database for fixed scenarios and
 *  writes or checks transcript-cases.json. The Rust database test replays the same steps
 *  through the installed package and compares status, body and the no-store header. It also
 *  loads the rows the old code wrote and reads them through Rust.
 *    transcript-oracle.ts write   regenerate the file from the old code
 *    transcript-oracle.ts check   fail when the old code no longer matches the file
 *  Run only through scripts/run-gate.sh. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import Fastify, { type FastifyRequest } from "fastify";
import { sql } from "kysely";
import { setMossErrorHandler } from "../../../apps/api/src/error-handling.js";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { MeetingRecordsRepository } from "../../../packages/meetings/src/repository.js";
import { registerMeetingHistoryRoutes } from "../../../packages/meetings/src/history-routes.js";
import { registerMeetingTranscriptRoutes } from "../../../packages/meetings/src/transcript-routes.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use scripts/run-gate.sh");

const file = new URL("./transcript-cases.json", import.meta.url);
const K = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MISSING = "99999999-9999-4999-8999-999999999999";

interface Step {
  /** Who calls. */
  as?: "a" | "b";
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** Sent as the raw request text, for malformed JSON. */
  raw?: string;
  /** The reply is decided by the shell, so a difference is reported and not failed. */
  shell?: boolean;
  /** Replayed again against rows the old code wrote. */
  reread?: boolean;
}
interface Scenario {
  name: string;
  /** Extra meetings made for person A, named M2, M3. */
  extra?: number;
  steps: Step[];
}

const source = (extra: object = {}) => ({
  sourceId: "mic",
  epoch: 1,
  kind: "microphone",
  label: "Microphone",
  startMs: 0,
  endMs: 1000,
  ...extra
});
const segment = (n: number, text: string, extra: object = {}) => ({
  cursor: n,
  segment: {
    meetingId: "{M}",
    segmentId: `s${n}`,
    sourceId: "mic",
    epoch: 1,
    startMs: n * 10,
    endMs: n * 10 + 9,
    revision: 1,
    text,
    finality: "final",
    provenance: "transcription",
    speakerId: null,
    ...extra
  }
});
const batch = (n: number, version: number, events: unknown[], extra: object = {}) => ({
  requestKey: K(n),
  expectedVersion: version,
  sources: [source()],
  events,
  stopCutoffMs: null,
  ...extra
});
const post = (body: unknown, extra: Partial<Step> = {}): Step => ({
  method: "POST",
  path: "/api/meetings/records/{M}/transcript",
  body,
  ...extra
});
const read = (query: Record<string, string> = {}, extra: Partial<Step> = {}): Step => ({
  method: "GET",
  path: "/api/meetings/records/{M}/transcript",
  query: { maxSegments: "500", maxCharacters: "100000", ...query },
  ...extra
});
const evidence = (query: Record<string, string>, extra: Partial<Step> = {}): Step => ({
  method: "GET",
  path: "/api/meetings/records/{M}/transcript/evidence",
  query,
  ...extra
});
const search = (body: unknown, extra: Partial<Step> = {}): Step => ({
  method: "POST",
  path: "/api/meetings/history/search",
  body,
  ...extra
});
const one = (id = "{M}", extra: Partial<Step> = {}): Step => ({
  method: "GET",
  path: `/api/meetings/history/${id}`,
  ...extra
});
const ev = (s: string, r: string, a: string, b: string) => ({
  segmentId: s,
  segmentRevision: r,
  startCharacter: a,
  endCharacter: b
});

const SCENARIOS: Scenario[] = [
  {
    name: "saving, replaying and correcting",
    steps: [
      post(
        batch(1, 0, [
          segment(1, "Hello budget planning", { finality: "provisional" }),
          segment(2, "Second line")
        ])
      ),
      post(
        batch(1, 0, [
          segment(1, "Hello budget planning", { finality: "provisional" }),
          segment(2, "Second line")
        ])
      ),
      post(batch(1, 0, [segment(1, "Changed text")])),
      post(batch(2, 0, [segment(3, "Late")])),
      post(
        batch(3, 1, [segment(3, "Corrected line", { segmentId: "s1", revision: 2 })], {
          stopCutoffMs: 500
        })
      ),
      post(batch(4, 2, [segment(4, "Again")], { stopCutoffMs: null })),
      post(batch(5, 2, [segment(4, "Again")], { stopCutoffMs: 400 })),
      read({}, { reread: true }),
      read({ transcriptRevision: "2" }, { reread: true }),
      read({ cutoffMs: "100" }, { reread: true }),
      read({ maxSegments: "1" }, { reread: true }),
      read({ maxCharacters: "14" }, { reread: true }),
      evidence(ev("s2", "1", "0", "6"), { reread: true }),
      evidence(ev("s1", "2", "0", "9"), { reread: true }),
      evidence(ev("s1", "1", "0", "5"), { reread: true }),
      one("{M}", { reread: true }),
      search({ query: "budget" }, { reread: true }),
      search({ query: "corrected" }, { reread: true }),
      search({ query: "Hello" }, { reread: true }),
      search({ filter: "transcript" }, { reread: true }),
      search({ filter: "needs-review" }, { reread: true }),
      search({ filter: "notes-only" }, { reread: true }),
      search({ filter: "exported" }, { reread: true })
    ]
  },
  {
    name: "unicode text and character ranges",
    steps: [
      post(batch(1, 0, [segment(1, "a😀b Straße naïve"), segment(2, "x\u{1F600}\u{1F600}y")])),
      read({}, { reread: true }),
      evidence(ev("s1", "1", "1", "3"), { reread: true }),
      evidence(ev("s1", "1", "2", "3"), { reread: true }),
      evidence(ev("s1", "1", "1", "2"), { reread: true }),
      evidence(ev("s1", "1", "0", "17"), { reread: true }),
      evidence(ev("s1", "1", "0", "18"), { reread: true }),
      evidence(ev("s1", "1", "3", "3"), { reread: true }),
      evidence(ev("s1", "1", "4", "3"), { reread: true }),
      search({ query: "straße" }, { reread: true }),
      search({ query: "NAÏVE" }, { reread: true }),
      search({ query: "!!!" }, { reread: true }),
      search({ query: "a b c d e f g h i j k l m n o p q" }, { reread: true }),
      search({ query: "a b c d e f g h i j k l m n o p" }, { reread: true })
    ]
  },
  {
    name: "refused batches",
    steps: [
      post(batch(1, 0, [segment(1, "x")], { requestKey: "nope" })),
      post({ ...batch(1, 0, [segment(1, "x")]), extra: 1 }),
      post({ requestKey: K(1), expectedVersion: 0, sources: [source()], events: [] }),
      post(batch(1, 0, [segment(1, "x")], { sources: [source({ kind: "phone" })] })),
      post(batch(1, 0, [segment(1, "x")], { sources: [source({ extra: 1 })] })),
      post(batch(1, 0, [segment(1, "x")], { sources: [source({ epoch: 0 })] })),
      post(batch(1, 0, [segment(1, "x")], { sources: [source({ label: "" })] })),
      post(batch(1, 0, [segment(1, "x", { finality: "maybe" })])),
      post(batch(1, 0, [segment(1, "x", { provenance: "guess" })])),
      post(batch(1, 0, [segment(1, "x", { revision: 0 })])),
      post(batch(1, 0, [segment(1, "x", { speakerId: 5 })])),
      post(batch(1, 0, [segment(1, "x", { extra: 1 })])),
      post(batch(1, 0, [segment(1, "x", { meetingId: MISSING })])),
      post(batch(1, 0, [segment(1, "x", { meetingId: "{M}" })], { stopCutoffMs: -1 })),
      post(batch(1, 0, [segment(1, "x")], { stopCutoffMs: "5" })),
      post(batch(1, 0, [segment(1, "x")], { sources: [] })),
      post(batch(1, 0, [segment(1, "x")], { expectedVersion: -1 })),
      post(batch(1, 0, [segment(1, "x")], { expectedVersion: 1.5 })),
      post(batch(1, 0, [segment(1, "x")], { expectedVersion: 4096 })),
      post(batch(1, 0, [segment(1, "x")], { expectedVersion: 4095 })),
      post(batch(1, 0, [segment(2, "x"), segment(1, "y")])),
      post(batch(1, 0, [segment(1, "x"), segment(1, "y")])),
      post(batch(1, 0, [segment(1, "x\u0000y")])),
      post(batch(1, 0, [segment(1, "x".repeat(100001))])),
      post(batch(1, 0, [segment(1, "é".repeat(100000))])),
      post(
        batch(
          1,
          0,
          Array.from({ length: 101 }, (_, i) => segment(i + 1, "a"))
        )
      ),
      post(
        batch(1, 0, [segment(1, "x")], {
          sources: Array.from({ length: 129 }, (_, i) => source({ sourceId: `m${i}` }))
        })
      ),
      post(batch(1, 0, [segment(1, "x")], { sources: [source({ label: "q".repeat(257) })] })),
      post(batch(1, 0, [segment(1, "x", { segmentId: "  " })])),
      post(batch(1, 0, [segment(1, "x", { segmentId: "s".repeat(256) })])),
      post(batch(1, 0, [segment(1, "x", { segmentId: "s".repeat(257) })])),
      post([]),
      post("text"),
      post(null),
      { method: "POST", path: "/api/meetings/records/{M}/transcript", raw: "{bad", shell: true },
      { method: "POST", path: "/api/meetings/records/{M}/transcript", raw: "", shell: true },
      {
        method: "POST",
        path: "/api/meetings/records/nope/transcript",
        body: batch(1, 0, [segment(1, "x")])
      },
      {
        method: "POST",
        path: `/api/meetings/records/${MISSING}/transcript`,
        body: batch(1, 0, [segment(1, "x", { meetingId: MISSING })])
      },
      read(),
      one(),
      search({})
    ]
  },
  {
    name: "refused reads",
    steps: [
      post(batch(1, 0, [segment(1, "text")])),
      read({}, { reread: false }),
      { method: "GET", path: "/api/meetings/records/{M}/transcript" },
      read({ maxSegments: "0" }),
      read({ maxSegments: "501" }),
      read({ maxSegments: "abc" }),
      read({ maxSegments: "1.5" }),
      read({ maxSegments: "1e1" }),
      read({ maxSegments: " 5 " }),
      read({ maxSegments: "0x10" }),
      read({ maxCharacters: "0" }),
      read({ maxCharacters: "100001" }),
      read({ transcriptRevision: "-1" }),
      read({ transcriptRevision: "5" }),
      read({ cutoffMs: "-1" }),
      read({ cutoffMs: "99999999999999999999" }),
      read({ extra: "1" }),
      evidence({}),
      evidence(ev("s1", "0", "0", "1")),
      evidence(ev("s1", "1", "-1", "1")),
      evidence(ev("s1", "1", "0", "0")),
      evidence({ ...ev("s1", "1", "0", "1"), extra: "1" }),
      evidence(ev("", "1", "0", "1")),
      evidence(ev("nope", "1", "0", "1")),
      {
        method: "GET",
        path: "/api/meetings/records/nope/transcript",
        query: { maxSegments: "5", maxCharacters: "5" }
      },
      {
        method: "GET",
        path: `/api/meetings/records/${MISSING}/transcript`,
        query: { maxSegments: "5", maxCharacters: "5" }
      },
      {
        method: "GET",
        path: `/api/meetings/records/${MISSING}/transcript/evidence`,
        query: ev("s1", "1", "0", "1")
      }
    ]
  },
  {
    name: "History input and paging",
    extra: 2,
    steps: [
      post(batch(1, 0, [segment(1, "alpha beta")])),
      {
        method: "POST",
        path: "/api/meetings/records/{M2}/transcript",
        body: batch(2, 0, [segment(1, "beta gamma", { meetingId: "{M2}" })])
      },
      search({}, { reread: true }),
      search({ limit: 1 }),
      search({ query: "beta", limit: 1 }),
      search({ query: "alpha beta" }),
      search({ query: "alpha gamma" }),
      search({ query: "title" }),
      search({ query: "  " }),
      search({ query: "" }),
      search({ typeId: "one-to-one" }),
      search({ limit: 50, filter: "all" }),
      search({ before: { id: "{M}", dateAt: "2099-01-01T00:00:00.000Z" } }),
      search({ before: { id: "{M}", dateAt: "2000-01-01T00:00:00.000Z" } }),
      search({ limit: 1.0 }),
      search({ limit: 0 }),
      search({ limit: 51 }),
      search({ limit: "5" }),
      search({ limit: null }),
      search({ query: null }),
      search({ query: 5 }),
      search({ query: "x".repeat(257) }),
      search({ query: "é".repeat(256) }),
      search({ query: "é".repeat(257) }),
      search({ query: "\u0000" }),
      search({ filter: "nope" }),
      search({ filter: null }),
      search({ typeId: "Bad" }),
      search({ typeId: null }),
      search({ before: null }),
      search({ before: {} }),
      search({ before: { id: "{M}" } }),
      search({ before: { id: "x", dateAt: "2026-01-01T00:00:00.000Z" } }),
      search({ before: { id: "{M}", dateAt: "2026-01-01T00:00:00Z" } }),
      search({ before: { id: "{M}", dateAt: "nope" } }),
      search({ before: { id: "{M}", dateAt: "2026-01-01T00:00:00.000Z", x: 1 } }),
      search({ extra: 1 }),
      search([]),
      search(null),
      search("x"),
      search(5),
      { method: "POST", path: "/api/meetings/history/search", raw: "", shell: true },
      { method: "POST", path: "/api/meetings/history/search", raw: "{bad", shell: true },
      one(MISSING),
      one("nope"),
      one("{M2}")
    ]
  },
  {
    name: "another person sees nothing",
    steps: [
      post(batch(1, 0, [segment(1, "private secret words")])),
      read({}, { as: "b" }),
      evidence(ev("s1", "1", "0", "5"), { as: "b" }),
      post(batch(2, 1, [segment(2, "intruder", { meetingId: "{M}" })]), { as: "b" }),
      post(batch(1, 0, [segment(1, "private secret words")]), { as: "b" }),
      one("{M}", { as: "b" }),
      search({ query: "secret" }, { as: "b" }),
      search({}, { as: "b" }),
      read({}, { as: "a", reread: true })
    ]
  }
];

const urls = getMossDatabaseUrls();
const boot = createDatabase({ connectionString: urls.bootstrap, maxConnections: 1 });
const appDb = createDatabase({ connectionString: urls.app, maxConnections: 2 });
const runner = new DataContextRunner(appDb as never);
const records = new MeetingRecordsRepository();

const server = Fastify();
const deps = {
  dataContext: runner,
  resolveAccessContext: async (request: FastifyRequest) => {
    const user = request.headers.authorization?.replace("Bearer ", "");
    if (!user) throw new Error("Unauthorized");
    return { actorUserId: user, requestId: "transcript-oracle" };
  }
};
registerMeetingHistoryRoutes(server, deps as never);
registerMeetingTranscriptRoutes(server, deps as never);
setMossErrorHandler(server);

const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const normal = (text: string, names: Record<string, string>) => {
  let out = text.replace(TIME, "<time>");
  for (const [name, id] of Object.entries(names)) out = out.split(id).join(`{${name}}`);
  return out;
};
const fill = (value: string, names: Record<string, string>) => {
  let out = value;
  for (const [name, id] of Object.entries(names)) out = out.split(`{${name}}`).join(id);
  return out;
};
const deep = <T>(value: T, names: Record<string, string>): T =>
  JSON.parse(fill(JSON.stringify(value), names)) as T;

async function run(scenario: Scenario) {
  const users = { a: randomUUID(), b: randomUUID() };
  for (const [key, id] of Object.entries(users))
    await sql`INSERT INTO app.users (id, email, name, is_instance_admin)
      VALUES (${id}::uuid, ${`${id}@example.test`}, ${`Oracle ${key}`}, false)`.execute(boot);
  const names: Record<string, string> = {};
  for (let i = 0; i < 1 + (scenario.extra ?? 0); i++) {
    const made = await runner.withDataContext({ actorUserId: users.a } as never, (db) =>
      records.create(db, { requestKey: randomUUID(), title: `Oracle meeting ${i + 1}` })
    );
    names[i === 0 ? "M" : `M${i + 1}`] = made.meeting.id;
  }
  const results = [];
  for (const step of scenario.steps) {
    const url = fill(step.path, names);
    const response = await server.inject({
      method: step.method,
      url,
      query: step.query,
      headers: {
        authorization: `Bearer ${users[step.as ?? "a"]}`,
        ...(step.raw !== undefined || step.body !== undefined
          ? { "content-type": "application/json" }
          : {})
      },
      ...(step.raw !== undefined
        ? { payload: step.raw }
        : step.body === undefined
          ? {}
          : { payload: JSON.stringify(deep(step.body, names)) })
    });
    let body: unknown = response.body;
    try {
      body = JSON.parse(normal(response.body, names));
    } catch {
      body = normal(response.body, names);
    }
    results.push({
      ...step,
      status: response.statusCode,
      noStore: response.headers["cache-control"] === "no-store",
      reply: body
    });
  }
  // The rows the old code left behind, so Rust can read them.
  const batches = await sql<Record<string, unknown>>`
    SELECT request_key::text, version, input_json, transcript_revision, cursor, stop_cutoff_ms,
      history_sources_json, history_omitted_sources
    FROM app.meeting_transcript_batches WHERE meeting_id = ${names.M}::uuid ORDER BY version`.execute(
    boot
  );
  const segments = await sql<Record<string, unknown>>`
    SELECT segment_key, revision, start_ms, end_ms, finality, search_terms
    FROM app.meeting_history_segments WHERE meeting_id = ${names.M}::uuid ORDER BY segment_key`.execute(
    boot
  );
  const swap = (v: unknown) => JSON.parse(normal(JSON.stringify(v), names)) as unknown;
  return {
    name: scenario.name,
    extra: scenario.extra ?? 0,
    steps: results,
    rows: swap({ batches: batches.rows, segments: segments.rows })
  };
}

try {
  await server.ready();
  const results = [];
  for (const scenario of SCENARIOS) results.push(await run(scenario));
  // Long runs of one character are stored as ~~REP(char,count)~~ to keep the file small.
  const pack = (t: string) =>
    t.replace(/(.)\1{199,}/gu, (run, ch: string) => `~~REP(${ch},${[...run].length})~~`);
  const text = pack(`[\n${results.map((r) => `  ${JSON.stringify(r)}`).join(",\n")}\n]\n`);
  if (process.argv[2] === "write") {
    writeFileSync(file, text);
    console.log(
      `wrote ${results.length} scenarios, ${results.reduce((n, r) => n + r.steps.length, 0)} steps`
    );
  } else {
    assert.equal(text, readFileSync(file, "utf8"));
    console.log("transcript-cases.json matches the old code");
  }
} finally {
  await server.close();
  await appDb.destroy();
  await boot.destroy();
}
