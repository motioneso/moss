import { afterEach, describe, expect, it, vi } from "vitest";
import { dataContextBrand, type DataContextDb } from "@moss/db";
import { renderToolResult } from "@moss/module-sdk";
import { appCallActionExecute } from "../../packages/settings/src/app-action-tools.js";
import {
  RecordingTypesRepository,
  DEFAULT_RECORDING_TYPES
} from "../../packages/meetings/src/recording-types.js";
import {
  validateRecordingTypeConfiguration,
  prepareRecordingTypeConfiguration
} from "../../packages/meetings/src/recording-type-config.js";
import { recordingTypeConfigurationPresentation } from "../../packages/meetings/src/recording-type-presentations.js";
import { meetingRecordingOutputGuidance } from "../../packages/meetings/src/output-guidance.js";
import { MEETING_OUTPUT_COMMON_GUIDANCE } from "../../packages/meetings/src/output-validation.js";
import { recordingContext } from "../fixtures/meeting-recording.js";
const current = { revision: 0, types: DEFAULT_RECORDING_TYPES };
const input = () => ({
  expectedRevision: 0,
  types: DEFAULT_RECORDING_TYPES.map((type) => ({ ...type }))
});
const db = { [dataContextBrand]: true } as DataContextDb;
const ctx = { actorUserId: "owner", chatSessionId: "session", requestId: "request" };
afterEach(() => vi.restoreAllMocks());

describe("recording type configuration boundary", () => {
  it("normalizes names and descriptions and retains stable IDs on add/rename/retirement", () => {
    const raw = input();
    raw.types[0]!.name = "  Project review  ";
    raw.types[0]!.description = "  Progress and risks  ";
    raw.types[1]!.retired = true;
    raw.types.push({
      id: "field-notes",
      name: "Field notes",
      description: "Observations outdoors",
      templateId: "general",
      retired: false
    });
    const result = prepareRecordingTypeConfiguration(current, raw);
    expect(result.revision).toBe(1);
    expect(result.types[0]).toMatchObject({
      id: "work-meeting",
      name: "Project review",
      description: "Progress and risks"
    });
    expect(result.types[1]).toMatchObject({ id: "appointment", retired: true });
    expect(result.types.at(-1)?.id).toBe("field-notes");
  });
  it.each([
    (raw: ReturnType<typeof input>) => ({ ...raw, unknown: true }),
    (raw: ReturnType<typeof input>) => ({ ...raw, expectedRevision: -1 }),
    (raw: ReturnType<typeof input>) => ({ ...raw, expectedRevision: 2147483647 }),
    (raw: ReturnType<typeof input>) => ({
      ...raw,
      types: raw.types.map((type) => ({ ...type, retired: true }))
    }),
    (raw: ReturnType<typeof input>) => ({ ...raw, types: [...raw.types, raw.types[0]] }),
    (raw: ReturnType<typeof input>) => ({
      ...raw,
      types: raw.types.map((type) => ({ ...type, name: "same" }))
    }),
    (raw: ReturnType<typeof input>) => ({
      ...raw,
      types: raw.types.map((type) => ({ ...type, description: " " }))
    }),
    (raw: ReturnType<typeof input>) => ({
      ...raw,
      types: raw.types.map((type) => ({ ...type, templateId: "unknown" }))
    }),
    (raw: ReturnType<typeof input>) => ({
      ...raw,
      types: raw.types.map((type) => ({ ...type, hidden: "surprise" }))
    }),
    (raw: ReturnType<typeof input>) => ({
      ...raw,
      types: raw.types.map((type) => ({ ...type, name: "\0" }))
    })
  ])("rejects malformed and undisclosed fields (%#)", (mutate) => {
    expect(() => validateRecordingTypeConfiguration(mutate(input()))).toThrow();
  });
  it("rejects case-folded trimmed duplicate names, lost IDs, new retired IDs and stale revisions", () => {
    const raw = input();
    raw.types[1]!.name = " work MEETING ";
    expect(() => validateRecordingTypeConfiguration(raw)).toThrow();
    expect(() =>
      prepareRecordingTypeConfiguration(current, { ...input(), types: input().types.slice(1) })
    ).toThrow();
    const extra = { ...input().types[0]!, id: "retired-new", retired: true };
    expect(() =>
      prepareRecordingTypeConfiguration(current, { ...input(), types: [...input().types, extra] })
    ).toThrow();
    expect(() => prepareRecordingTypeConfiguration({ ...current, revision: 1 }, input())).toThrow(
      "recording_type_configuration_conflict"
    );
  });
  it("counts retired entries and enforces serialized UTF-8 and rendered limits separately", () => {
    const many = Array.from({ length: 33 }, (_, index) => ({
      ...input().types[0]!,
      id: `type-${index}`,
      name: `Type ${index}`,
      retired: index > 0
    }));
    expect(() => validateRecordingTypeConfiguration({ expectedRevision: 0, types: many })).toThrow(
      "recording_type_limit"
    );
    const huge = many.slice(0, 32).map((type) => ({ ...type, description: "\u0001".repeat(500) }));
    expect(() => validateRecordingTypeConfiguration({ expectedRevision: 0, types: huge })).toThrow(
      "recording_type_configuration_too_large"
    );
    const largeRendered = many
      .slice(0, 32)
      .map((type) => ({ ...type, description: "a".repeat(500) }));
    expect(() =>
      validateRecordingTypeConfiguration({ expectedRevision: 0, types: largeRendered })
    ).toThrow("recording_type_configuration_too_large");
  });
  it.each(['"\\\u0001', "🍃"])(
    "round-trips near-capacity escaped data through actual GET/PUT app-action envelopes (%s)",
    async (fragment) => {
      const types = Array.from({ length: 32 }, (_, index) => ({
        ...input().types[0]!,
        id: `type-${index}`,
        name: `Type ${index}`,
        retired: index > 0,
        description: fragment
      }));
      let last = types;
      for (let length = 1; length <= 200; length++) {
        const candidate = types.map((type) => ({ ...type, description: fragment.repeat(length) }));
        try {
          validateRecordingTypeConfiguration({ expectedRevision: 2147483646, types: candidate });
          last = candidate;
        } catch {
          break;
        }
      }
      const configuration = prepareRecordingTypeConfiguration(
        { revision: 2147483646, types: last },
        { expectedRevision: 2147483646, types: last }
      );
      expect(JSON.stringify(configuration, null, 2).length).toBeGreaterThan(11000);
      const services = {
        appActions: {
          catalog: () => null,
          call: async () => ({ status: 200, body: configuration })
        }
      };
      for (const method of ["GET", "PUT"]) {
        const result = await appCallActionExecute(
          db,
          {
            method,
            path: "/api/meetings/recording-types",
            ...(method === "PUT" ? { body: { expectedRevision: 2147483646, types: last } } : {})
          },
          ctx,
          services
        );
        const rendered = renderToolResult(result);
        expect(rendered.length).toBeLessThanOrEqual(16000);
        expect(JSON.parse(rendered).body).toEqual(configuration);
      }
    }
  );
  it("discloses complete before/after fields and binds approvals to current and proposed state", async () => {
    const get = vi.spyOn(RecordingTypesRepository.prototype, "get").mockResolvedValue(current);
    const raw = input();
    raw.types[0] = {
      ...raw.types[0]!,
      name: "Team review",
      description: "Progress and blockers",
      templateId: "project-review",
      retired: true
    };
    const request = { params: {}, target: "Untrusted target", body: raw };
    const first = await recordingTypeConfigurationPresentation(db, request, ctx);
    expect(first?.fields).toHaveLength(2);
    expect(first?.fields[0]?.value).toContain(
      "Name: Work meeting\nDescription: Work discussions, decisions and action items.\nSummary style: General meeting\nStatus: Active"
    );
    expect(first?.fields[1]?.value).toContain(
      "Name: Team review\nDescription: Progress and blockers\nSummary style: Project review\nStatus: Retired"
    );
    expect(
      await recordingTypeConfigurationPresentation(
        db,
        { ...request, query: { surprise: "yes" } },
        ctx
      )
    ).toBeNull();
    expect(
      await recordingTypeConfigurationPresentation(
        db,
        { ...request, body: { ...raw, hidden: true } },
        ctx
      )
    ).toBeNull();
    get.mockResolvedValue({ ...current, revision: 1 });
    expect(await recordingTypeConfigurationPresentation(db, request, ctx)).toBeNull();
    const next = await recordingTypeConfigurationPresentation(
      db,
      { ...request, body: { ...raw, expectedRevision: 1 } },
      ctx
    );
    expect(next?.version).not.toBe(first?.version);
  });
  it("keeps added fixed interpretation and style guidance below 150 words", () => {
    const inputs = {
      meetingId: "m",
      recording: recordingContext("m"),
      transcript: null,
      personalNotes: "",
      notesRevision: 0
    };
    const guidance = meetingRecordingOutputGuidance(inputs, { id: "general", version: 1 });
    const added = guidance
      .replace(MEETING_OUTPUT_COMMON_GUIDANCE, "")
      .split("Permitted type IDs:")[0]!;
    expect(added.trim().split(/\s+/).length).toBeLessThan(150);
    expect(guidance).toContain("project-review:");
    expect(guidance).toContain("Progress, risks");
  });
});
