import { afterEach, expect, it, vi } from "vitest";
import { createReplyNormalizer } from "../../packages/ai/src/structured/normalize-reply.js";
import {
  reminderEditSchema,
  validateReminderEdit
} from "../../packages/chat/src/reminders/edit-interpretation.js";
import { createAiSecretCipher, type AiRepository } from "@moss/ai";
import { prepareReminderEdit } from "../../packages/chat/src/reminders/prepare-edit.js";
import { makeRecordingDb } from "./helpers/recording-db.js";

vi.mock("../../packages/chat/src/reminders/edit-agreement.js", () => ({
  pendingReminderEdit: async () => undefined
}));
vi.mock("../../packages/chat/src/reminders/edit.js", () => ({
  readEditableReminders: async () => [
    {
      id: "reminder",
      version: 1,
      reminder_text: "edit proof original",
      due_at: new Date("2026-10-18T12:02:00Z"),
      deadline_at: null,
      state: "queued",
      repeat_kind: null,
      repeat_seconds: null,
      local_due: null,
      time_zone: "UTC"
    }
  ]
}));

const request =
  "change my edit proof original reminder text to edit proof revised and move it to 4 minutes from now";
const reply = {
  target: "edit proof original",
  unsupported: false,
  text: "edit proof revised",
  delaySeconds: 240,
  localDue: null,
  deadline: "keep",
  localDeadline: null,
  repeat: null,
  destination: null
};

async function prepare(content: string, status = 200) {
  const cipher = createAiSecretCipher();
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content } }]
        }),
        { status }
      )
  );
  vi.stubGlobal("fetch", fetch);
  const { scoped } = makeRecordingDb({ rows: [{ now: new Date("2026-10-18T12:00:00Z") }] });
  const ai = {
    resolveModelForService: async () => ({
      model: {
        id: "model",
        provider_config_id: "provider",
        provider_kind: "openai-compatible",
        provider_model_id: "synthetic-model"
      }
    }),
    selectProviderWithCredential: async () => ({
      auth_method: "api_key",
      base_url: "https://synthetic.invalid",
      encrypted_credential: cipher.encryptJson({ apiKey: "synthetic-key-only" })
    })
  } as unknown as AiRepository;
  const run = await prepareReminderEdit(scoped, ai, undefined, request, "main", {
    timeZone: "UTC",
    clockFormat: "24"
  });
  expect(fetch).not.toHaveBeenCalled();
  return { run, fetch };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["plain", "fenced", "untagged"])(
  "accepts a %s API reply for the reported combined edit",
  async (shape) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const content = JSON.stringify(reply);
    const { run, fetch } = await prepare(
      shape === "plain" ? content : `\`\`\`${shape === "fenced" ? "json" : ""}\n${content}\n\`\`\``
    );
    expect(await run()).toMatchObject({
      kind: "edit",
      proposal: {
        candidates: [{ id: "reminder", version: 1 }],
        terms: { text: "edit proof revised", delaySeconds: 240, localDue: null }
      }
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  }
);

it.each([
  ["json_parse", "Here is the answer: " + JSON.stringify(reply), 200],
  ["schema_validation", JSON.stringify({ ...reply, dueAt: "2026-10-18T12:04:00Z" }), 200],
  ["json_parse", "```json\n{broken}\n```", 200],
  ["json_parse", "```json\n" + JSON.stringify(reply) + "\n``` trailing prose", 200],
  ["schema_validation", JSON.stringify({ ...reply, unsupported: undefined }), 200],
  ["schema_validation", JSON.stringify({ ...reply, destination: 42 }), 200],
  [
    "invalid_edit_terms",
    JSON.stringify({ ...reply, localDue: "2026-10-18T12:04", delaySeconds: 240 }),
    200
  ],
  [
    "schema_validation",
    JSON.stringify({ ...reply, localDue: "2026-10-18T12:04Z", delaySeconds: null }),
    200
  ],
  ["invalid_edit_terms", JSON.stringify({ ...reply, deadline: "set" }), 200],
  ["target_not_in_request", JSON.stringify({ ...reply, target: "unmentioned reminder" }), 200],
  [
    "destination_not_in_request",
    JSON.stringify({ ...reply, destination: "unmentioned chat" }),
    200
  ],
  ["unsupported_edit", JSON.stringify({ ...reply, unsupported: true }), 200],
  ["no_matching_reminder", JSON.stringify({ ...reply, target: "4 minutes" }), 200],
  ["no_changes", JSON.stringify({ ...reply, text: null, delaySeconds: null }), 200],
  ["provider_failure", "synthetic private provider error", 400]
] as const)(
  "logs one fixed reason for %s without private content",
  async (reason, content, status) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { run, fetch } = await prepare(content, status);
    expect(await run()).toMatchObject({ kind: "edit_refused" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("reminder.edit refused", expect.objectContaining({ reason }));
    expect(fetch).toHaveBeenCalledTimes(1);
  }
);

it.each([
  { repeat: JSON.stringify({ kind: "interval", seconds: "300" }) },
  { repeat: "null" },
  { localDue: undefined },
  { delaySeconds: "240" }
])("accepts unambiguous edit reply repairs: %j", async (quirk) => {
  const { run } = await prepare(JSON.stringify({ ...reply, ...quirk }));
  expect(await run()).toMatchObject({ kind: "edit" });
});

it.each([
  [{ destination: 42 }, { keyword: "type", schemaPath: "#/properties/destination/type" }],
  [
    { repeat: { kind: "daily", OWNER_PRIVATE_SENTINEL: "OWNER_PRIVATE_SENTINEL" } },
    { keyword: "type", schemaPath: "#/properties/repeat/anyOf/0/type" }
  ],
  [
    { text: "OWNER_PRIVATE_SENTINEL", unsupported: undefined },
    { keyword: "required", schemaPath: "#/properties/unsupported" }
  ]
])(
  "logs only schema locations and rules for invalid private replies",
  async (invalid, validation) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { run } = await prepare(JSON.stringify({ ...reply, ...invalid }));
    expect(await run()).toMatchObject({ kind: "edit_refused" });
    expect(warn).toHaveBeenCalledWith("reminder.edit refused", {
      reason: "schema_validation",
      validation
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("OWNER_PRIVATE_SENTINEL");
    expect(logged).not.toContain("edit proof");
  }
);

const reportedReply = {
  repeat: "null",
  target: "edit proof original",
  unsupported: false,
  text: "edit proof revised",
  delaySeconds: null,
  localDue: null,
  deadline: "keep",
  localDeadline: null,
  destination: null
};

it("accepts the coordinator's exact string-null reply through both edit validators", async () => {
  expect(validateReminderEdit(reportedReply)).toBeUndefined();
  const normalized = createReplyNormalizer(reminderEditSchema)(reportedReply);
  expect(normalized).toEqual({ ...reportedReply, repeat: null });
  expect(validateReminderEdit(normalized)).toEqual(normalized);
  expect(reportedReply.repeat).toBe("null");
  const { run } = await prepare(JSON.stringify(reportedReply));
  expect(await run()).toMatchObject({
    kind: "edit",
    proposal: { terms: { repeat: null, text: "edit proof revised", delaySeconds: null } }
  });
});

it.each(["text", "target"])("preserves legitimate string-null words in %s", (field) => {
  const normalized = createReplyNormalizer(reminderEditSchema)({
    ...reportedReply,
    [field]: "null"
  });
  expect(normalized).toEqual({ ...reportedReply, repeat: null, [field]: "null" });
  expect(validateReminderEdit(normalized)).toEqual(normalized);
});
