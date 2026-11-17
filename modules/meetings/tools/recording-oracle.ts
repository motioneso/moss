/** Runs the old recording-type, recording-identity and pasted-transcript routes against a real
 *  database for fixed scenarios and writes or checks recording-cases.json. The Rust database test
 *  replays the same steps through the installed package, compares status and body, compares the
 *  stored rows, and reads rows the old code wrote through Rust.
 *    recording-oracle.ts write   regenerate the file from the old code
 *    recording-oracle.ts check   fail when the old code no longer matches the file
 *  Run only through scripts/run-gate.sh. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import Fastify, { type FastifyRequest } from "fastify";
import { sql } from "kysely";
import { setMossErrorHandler } from "../../../apps/api/src/error-handling.js";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { MeetingRecordsRepository } from "../../../packages/meetings/src/repository.js";
import { registerMeetingTranscriptRoutes } from "../../../packages/meetings/src/transcript-routes.js";
import { registerRecordingRoutes } from "../../../packages/meetings/src/recording-routes.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use scripts/run-gate.sh");

const file = new URL("./recording-cases.json", import.meta.url);
const K = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MISSING = "99999999-9999-4999-8999-999999999999";

interface Step {
  /** Who calls. */
  as?: "a" | "b";
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: unknown;
  /** Sent as the raw request text, for malformed JSON. */
  raw?: string;
  /** The reply is decided by the shell, so a difference is reported and not failed. */
  shell?: boolean;
  /** Names the meeting this reply created, so later steps and the stored rows can refer to it. */
  save?: string;
  /** Replayed again against rows the old code wrote. */
  reread?: boolean;
}
interface Scenario {
  name: string;
  /** Extra meetings made for person A, named M2, M3. */
  extra?: number;
  steps: Step[];
}

const base = "/api/meetings";
const defaults = [
  ["work-meeting", "Work meeting", "Work discussions, decisions and action items."],
  ["appointment", "Appointment", "A scheduled appointment or consultation."],
  ["brain-dump", "Brain dump", "Thinking aloud, loose thoughts and grouped ideas."],
  ["conversation", "Conversation", "An informal conversation with other people."],
  ["idea", "Idea", "A focused idea or proposal to develop."],
  ["other", "Other", "A recording that does not fit another active type."]
];
const kind = (
  id: string,
  name = id,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id,
  name,
  description: "A type.",
  templateId: "general",
  retired: false,
  ...extra
});
const base6 = () => defaults.map(([id, name, description]) => kind(id, name, { description }));
const withTypes = (
  extra: Record<string, unknown>[],
  revision = 0,
  patch = (l: Record<string, unknown>[]) => l
) => ({
  expectedRevision: revision,
  types: patch([...base6(), ...extra])
});
const putTypes = (body: unknown, extra: Partial<Step> = {}): Step => ({
  method: "PUT",
  path: `${base}/recording-types`,
  body,
  ...extra
});
const getTypes = (extra: Partial<Step> = {}): Step => ({
  method: "GET",
  path: `${base}/recording-types`,
  ...extra
});
const getRec = (id = "{M}", extra: Partial<Step> = {}): Step => ({
  method: "GET",
  path: `${base}/records/${id}/recording`,
  ...extra
});
const putKind = (body: unknown, id = "{M}", extra: Partial<Step> = {}): Step => ({
  method: "PUT",
  path: `${base}/records/${id}/recording/type`,
  body,
  ...extra
});
const paste = (body: unknown, extra: Partial<Step> = {}): Step => ({
  method: "POST",
  path: `${base}/manual-transcripts`,
  body,
  ...extra
});
const note = (n: number, extra: Record<string, unknown> = {}) => ({
  requestKey: K(n),
  transcript: "Alice: hello there\nBob: budget review",
  ...extra
});
const readTranscript = (id: string, extra: Partial<Step> = {}): Step => ({
  method: "GET",
  path: `${base}/records/${id}/transcript?maxSegments=500&maxCharacters=100000`,
  ...extra
});

const SCENARIOS: Scenario[] = [
  {
    name: "saving and retiring recording types",
    steps: [
      getTypes(),
      putTypes(withTypes([kind("standup", "Standup", { templateId: "one-to-one" })])),
      getTypes(),
      putTypes(withTypes([kind("standup", "Standup", { templateId: "one-to-one" })], 1)),
      putTypes(withTypes([kind("standup", "Standup", { templateId: "one-to-one" })], 0)),
      putTypes(withTypes([kind("standup", "Standup", { templateId: "one-to-one" })], 7)),
      putTypes(
        withTypes([kind("standup", "Standup", { templateId: "one-to-one" })], 1, (l) =>
          l.map((t) => (t.id === "idea" ? { ...t, retired: true } : t))
        )
      ),
      getTypes(),
      putTypes(
        withTypes([kind("standup", "Standup", { templateId: "one-to-one" })], 2, (l) =>
          l.map((t) => (t.id === "idea" ? { ...t, retired: false, name: "Big idea" } : t))
        )
      ),
      putTypes(
        withTypes([kind("review", "Review", { templateId: "project-review" })], 3, (l) =>
          l.map((t) => (t.id === "other" ? { ...t, templateId: "interview" } : t))
        )
      ),
      getTypes({ reread: true }),
      getTypes({ as: "b" })
    ]
  },
  {
    name: "refused recording type saves",
    steps: [
      putTypes(withTypes([], 0, (l) => l.slice(1))),
      putTypes(withTypes([kind("late", "Late", { retired: true })])),
      putTypes(withTypes([], 0, (l) => l.map((t) => ({ ...t, retired: true })))),
      putTypes(withTypes([kind("idea", "Another")])),
      putTypes(withTypes([kind("fresh", "WORK MEETING")])),
      putTypes(withTypes([kind("fresh", "  work meeting  ")])),
      putTypes(withTypes([kind("fresh", "")])),
      putTypes(withTypes([kind("fresh", "   ")])),
      putTypes(withTypes([kind("fresh", "n".repeat(81))])),
      putTypes(withTypes([kind("fresh", "n".repeat(80))], 0)),
      putTypes(withTypes([kind("fresh2", "ok", { description: "d".repeat(501) })])),
      putTypes(withTypes([kind("fresh2", "ok", { description: "d".repeat(500) })], 1)),
      putTypes(withTypes([kind("Bad", "Bad")], 2)),
      putTypes(withTypes([kind("9bad", "Bad")], 2)),
      putTypes(withTypes([kind("-bad", "Bad")], 2)),
      putTypes(withTypes([kind("a".repeat(65), "Bad")], 2)),
      putTypes(withTypes([kind("fresh3", "ok", { templateId: "nope" })], 2)),
      putTypes(withTypes([kind("fresh3", "ok", { retired: "no" })], 2)),
      putTypes(withTypes([kind("fresh3", "ok", { extra: 1 })], 2)),
      putTypes(withTypes([{ id: "fresh3", name: "ok" }], 2)),
      putTypes(withTypes([kind("fresh3", "ok"), kind("fresh3", "again")], 2)),
      putTypes({ expectedRevision: 0 }),
      putTypes({ types: base6() }),
      putTypes({ ...withTypes([]), extra: 1 }),
      putTypes({ expectedRevision: 0, types: [] }),
      putTypes({ expectedRevision: -1, types: base6() }),
      putTypes({ expectedRevision: 2147483647, types: base6() }),
      putTypes({ expectedRevision: 2147483646, types: base6() }),
      putTypes({ expectedRevision: 1.5, types: base6() }),
      putTypes({ expectedRevision: "0", types: base6() }),
      putTypes({ expectedRevision: 0, types: "none" }),
      putTypes({ expectedRevision: 0, types: [null] }),
      putTypes(
        withTypes(
          Array.from({ length: 27 }, (_, i) => kind(`extra-${i}`, `Extra ${i}`)),
          0
        )
      ),
      putTypes(
        withTypes(
          Array.from({ length: 26 }, (_, i) => kind(`extra-${i}`, `Extra ${i}`)),
          0
        )
      ),
      putTypes(
        withTypes(
          Array.from({ length: 26 }, (_, i) =>
            kind(`big-${i}`, `Big ${i}`, { description: "é".repeat(500) })
          ),
          1
        )
      ),
      putTypes(null),
      putTypes("text"),
      putTypes([]),
      { method: "PUT", path: `${base}/recording-types`, raw: "{not json", shell: true },
      { method: "PUT", path: `${base}/recording-types`, raw: "", shell: true },
      getTypes({ reread: true })
    ]
  },
  {
    name: "a meeting's recording type",
    extra: 1,
    steps: [
      getRec(),
      putKind({ expectedRevision: 0, typeId: "idea" }),
      getRec(),
      putKind({ expectedRevision: 0, typeId: "other" }),
      putKind({ expectedRevision: 1, typeId: "other" }),
      putKind({ expectedRevision: 2, typeId: "nope" }),
      putKind({ expectedRevision: 2, typeId: "Bad Id" }),
      putKind({ expectedRevision: 2, typeId: "" }),
      putKind({ expectedRevision: 2 }),
      putKind({ typeId: "idea" }),
      putKind({ expectedRevision: -1, typeId: "idea" }),
      putKind({ expectedRevision: 1.5, typeId: "idea" }),
      putKind({ expectedRevision: "2", typeId: "idea" }),
      putKind({ expectedRevision: 2, typeId: "idea", extra: 1 }),
      putKind(null),
      putKind([]),
      { method: "PUT", path: `${base}/records/{M}/recording/type`, raw: "{nope", shell: true },
      putKind({ expectedRevision: 0, typeId: "idea" }, "{M2}"),
      getRec("{M2}"),
      putKind({ expectedRevision: 0, typeId: "idea" }, MISSING),
      putKind({ expectedRevision: 0, typeId: "nope" }, MISSING),
      putKind({ expectedRevision: 0, typeId: "idea" }, "nope"),
      putKind({ expectedRevision: 0 }, "nope"),
      getRec(MISSING),
      getRec("nope"),
      putTypes({
        expectedRevision: 0,
        types: base6().map((t) => (t.id === "brain-dump" ? { ...t, retired: true } : t))
      }),
      putKind({ expectedRevision: 2, typeId: "brain-dump" }),
      putKind({ expectedRevision: 2, typeId: "conversation" }),
      getRec("{M}", { reread: true }),
      getRec("{M2}", { reread: true })
    ]
  },
  {
    name: "pasting a transcript",
    steps: [
      paste(note(1), { save: "P1" }),
      paste(note(1)),
      paste(note(1, { title: "Changed" })),
      paste(note(1, { transcript: "Different words" })),
      readTranscript("{P1}", { reread: true }),
      getRec("{P1}", { reread: true }),
      paste(note(2, { title: "  Budget sync  ", typeId: "idea" }), { save: "P2" }),
      paste(note(2, { title: "  Budget sync  ", typeId: "idea" })),
      paste(note(2, { title: "Budget sync", typeId: "idea" })),
      getRec("{P2}"),
      putKind({ expectedRevision: 0, typeId: "other" }, "{P2}"),
      paste(note(3, { recordedAt: "2026-01-02T03:04:05Z" }), { save: "P3" }),
      paste(note(4, { recordedAt: "2026-01-02T03:04:05.123456Z" }), { save: "P4" }),
      paste(note(5, { recordedAt: "2026-01-02T03:04:05+02:00" }), { save: "P5" }),
      paste(note(6, { recordedAt: "2026-01-02T03:04:05.5-0530" }), { save: "P6" }),
      paste(note(7, { transcript: "é😀 text with spaces " }), { save: "P7" }),
      readTranscript("{P7}", { reread: true }),
      paste(note(8, { transcript: "a".repeat(100000) }), { save: "P8" }),
      paste(note(9, { title: "t".repeat(240) }), { save: "P9" }),
      paste(note(10, { title: "é".repeat(120) }), { save: "P10" }),
      paste(note(11, { typeId: "nope" })),
      paste(note(11, { typeId: "nope" })),
      paste(note(11, { typeId: "idea" }), { save: "P11" }),
      paste(note(12, { requestKey: K(12).toUpperCase() }), { save: "P12" }),
      paste(note(12))
    ]
  },
  {
    name: "refused pasted transcripts",
    steps: [
      paste(null),
      paste([]),
      paste("text"),
      paste({}),
      paste({ requestKey: K(1) }),
      paste({ transcript: "words" }),
      paste(note(1, { extra: 1 })),
      paste(note(1, { requestKey: "nope" })),
      paste(note(1, { requestKey: 5 })),
      paste(note(1, { transcript: "" })),
      paste(note(1, { transcript: "  \n\t " })),
      paste(note(1, { transcript: "bad\u0000text" })),
      paste(note(1, { transcript: 5 })),
      paste(note(1, { transcript: "a".repeat(100001) })),
      paste(note(1, { transcript: "😀".repeat(50001) })),
      paste(note(1, { transcript: "😀".repeat(50000) }), { save: "P1" }),
      paste(note(2, { title: "" })),
      paste(note(2, { title: "   " })),
      paste(note(2, { title: "t".repeat(241) })),
      paste(note(2, { title: "é".repeat(121) })),
      paste(note(2, { title: 5 })),
      paste(note(2, { title: null })),
      paste(note(2, { typeId: "" })),
      paste(note(2, { typeId: "Bad Id" })),
      paste(note(2, { typeId: 5 })),
      paste(note(2, { recordedAt: "2026-01-02" })),
      paste(note(2, { recordedAt: "2026-01-02T03:04Z" })),
      paste(note(2, { recordedAt: "2026-01-02T03:04:05" })),
      paste(note(2, { recordedAt: "2026-01-02 03:04:05Z" })),
      paste(note(2, { recordedAt: "2026-01-02t03:04:05z" })),
      paste(note(2, { recordedAt: "2026-13-01T00:00:00Z" })),
      paste(note(2, { recordedAt: "2026-02-30T00:00:00Z" })),
      paste(note(2, { recordedAt: "2026-01-02T24:00:00Z" })),
      paste(note(2, { recordedAt: "2026-01-02T23:59:60Z" })),
      paste(note(2, { recordedAt: "nope" })),
      paste(note(2, { recordedAt: 5 })),
      paste(note(2, { recordedAt: "" })),
      paste(note(2, { recordedAt: "0001-01-01T00:00:00Z" })),
      paste(note(2, { recordedAt: "9999-12-31T23:59:59.999Z" })),
      { method: "POST", path: `${base}/manual-transcripts`, raw: "{nope", shell: true },
      { method: "POST", path: `${base}/manual-transcripts`, raw: "", shell: true }
    ]
  },
  {
    name: "another person sees nothing",
    steps: [
      putTypes(withTypes([kind("private-kind", "Private kind")])),
      getTypes({ as: "b" }),
      getRec(),
      getRec("{M}", { as: "b" }),
      putKind({ expectedRevision: 0, typeId: "idea" }, "{M}", { as: "b" }),
      putKind({ expectedRevision: 0, typeId: "private-kind" }, "{M}", { as: "b" }),
      paste(note(1, { transcript: "private secret words" }), { save: "P1" }),
      paste(note(1, { transcript: "private secret words" }), { as: "b" }),
      paste(note(2, { typeId: "private-kind" }), { as: "b" }),
      getRec("{P1}", { as: "b" }),
      readTranscript("{P1}", { as: "b" }),
      putKind({ expectedRevision: 0, typeId: "idea" }, "{P1}", { as: "b" }),
      getTypes({ reread: true }),
      getRec("{P1}", { reread: true })
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
  manualSummaryEnqueue: async () => undefined,
  resolveAccessContext: async (request: FastifyRequest) => {
    const user = request.headers.authorization?.replace("Bearer ", "");
    if (!user) throw new Error("Unauthorized");
    return { actorUserId: user, requestId: "recording-oracle" };
  }
};
registerRecordingRoutes(server, deps as never);
registerMeetingTranscriptRoutes(server, deps as never);
setMossErrorHandler(server);

const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g;
const normal = (text: string, names: Record<string, string>) => {
  // The owner is a fresh random user each run, so the recording keeps a placeholder.
  let out = text
    .replace(TIME, "<time>")
    .replace(/"ownerUserId":"[0-9a-f-]{36}"/g, '"ownerUserId":"<id>"');
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
    const response = await server.inject({
      method: step.method,
      url: fill(step.path, names),
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
    if (step.save) {
      const made = (JSON.parse(response.body) as { meetingId?: string }).meetingId;
      if (made) names[step.save] = made;
    }
    let body: unknown;
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
  // The rows the old code left behind, so Rust can compare and read them.
  const ids = Object.entries(names).sort(([x], [y]) => x.localeCompare(y));
  const types = await sql<Record<string, unknown>>`
    SELECT revision, types_json FROM app.meeting_recording_types
    WHERE owner_user_id = ${users.a}::uuid`.execute(boot);
  const meetings: Record<string, unknown> = {};
  for (const [name, id] of ids) {
    const metadata = await sql<Record<string, unknown>>`
      SELECT revision, type_id, type_source, title_source, side, confidence, reason,
        (extract(epoch FROM recorded_at) * 1000)::bigint::text AS recorded_at_ms, source, output_version
      FROM app.meeting_recording_metadata WHERE meeting_id = ${id}::uuid`.execute(boot);
    const entries = await sql<Record<string, unknown>>`
      SELECT request_key::text, input_hash, transcript_revision
      FROM app.meeting_manual_entries WHERE meeting_id = ${id}::uuid`.execute(boot);
    const batches = await sql<Record<string, unknown>>`
      SELECT request_key::text, version, input_json, transcript_revision, cursor, stop_cutoff_ms,
        history_sources_json, history_omitted_sources
      FROM app.meeting_transcript_batches WHERE meeting_id = ${id}::uuid ORDER BY version`.execute(
      boot
    );
    meetings[name] = {
      metadata: metadata.rows,
      entries: entries.rows,
      batches: batches.rows
    };
  }
  const swap = (v: unknown) => JSON.parse(normal(JSON.stringify(v), names)) as unknown;
  return {
    name: scenario.name,
    extra: scenario.extra ?? 0,
    steps: results,
    rows: swap({ types: types.rows, meetings })
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
    console.log("recording-cases.json matches the old code");
  }
} finally {
  await server.close();
  await appDb.destroy();
  await boot.destroy();
}
