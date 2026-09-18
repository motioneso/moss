import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { PNG } from "pngjs";
import { MOCKUPS } from "../../tests/uat/visual-parity/mockups.js";
import { compareReferenceCapture } from "../../tests/uat/visual-parity/capture.js";
import {
  HARNESS_FILES,
  assertArtifactDirsDistinct,
  computeHarnessDigest,
  parseCaseSelection,
  resolveCaseSelection,
  resolveCaseSelectionManifest,
  runSetupActions,
  selectedSetupActions,
  statePrerequisites,
  validateRunManifest,
  type SelectedGuard,
  type SetupActionHandlers
} from "../../tests/uat/visual-parity/case-selection.js";
import {
  buildRegionRunRecord,
  parseRegionSet
} from "../../tests/uat/visual-parity/region-comparison.js";

const guards: readonly SelectedGuard[] = [
  { route: "tasks", path: "/tasks", width: 1440, role: "base-guard" },
  { route: "tasks", path: "/tasks", width: 375, role: "base-guard" }
];
const selectedCase = { dir: MOCKUPS[0]!.dir, name: MOCKUPS[0]!.name, role: "measurement" as const };
const PINNED_OPTIONS = (root: string, head = "a".repeat(40)) => ({
  artifactRoot: root,
  expectedHead: head,
  expectedBase: null as string | null,
  expectedHarnessFiles: HARNESS_FILES,
  expectedFixture: { seedDate: "2026-09-17", timeZone: "America/Los_Angeles" }
});

describe("visual parity case selection", () => {
  it("selects exact directory/name identities and never silently falls back to all cases", () => {
    const selection = resolveCaseSelectionManifest(
      parseCaseSelection({
        version: 1,
        cases: [selectedCase],
        guards
      }),
      {
        mockups: MOCKUPS
      }
    );
    expect(selection.mode).toBe("selected");
    expect(selection.entries).toHaveLength(1);
    expect(selection.entries[0]).toBe(MOCKUPS[0]);
  });

  it("rejects empty, unknown, duplicate, contradictory and unsafe declarations", () => {
    expect(() => parseCaseSelection({ version: 1, cases: [], guards })).toThrow(
      "cases must be nonempty"
    );
    expect(() =>
      parseCaseSelection({
        version: 1,
        cases: [{ ...selectedCase, dir: "missing" }],
        guards
      })
    ).not.toThrow();
    expect(() =>
      parseCaseSelection({
        version: 1,
        cases: [{ ...selectedCase, reference: "../base.png" }],
        guards
      })
    ).toThrow("unsafe");
    expect(() =>
      parseCaseSelection({
        version: 1,
        cases: [selectedCase, selectedCase],
        guards
      })
    ).toThrow("duplicate");
    expect(() =>
      parseCaseSelection({
        version: 1,
        cases: [selectedCase],
        guards: [{ route: "tasks", path: "/calendar", width: 1440, role: "base-guard" }]
      })
    ).toThrow("contradictory");
  });

  it("fails closed when declared capture accounting is incomplete or duplicated", () => {
    const selection = {
      mode: "selected" as const,
      entries: [MOCKUPS[0]!],
      cases: [selectedCase],
      guards,
      artifacts: {
        root: "HEAD/ATTEMPT",
        selection: "selection.json",
        manifest: "manifest.json",
        captures: "captures",
        raw: "raw",
        diffs: "diffs",
        controls: "controls",
        timings: "timings.json",
        failure: "failure"
      }
    };
    const root = mkdtempSync(join(tmpdir(), "parity-selection-"));
    writeFileSync(join(root, "selection.json"), "{}");
    writeFileSync(join(root, "manifest.json"), "{}");
    writeFileSync(join(root, "timings.json"), "{}");
    const writeArtifact = (path: string) => {
      const bytes = `${path}\n`;
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), bytes);
      return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    const capture = {
      identity: `${MOCKUPS[0]!.dir}/${MOCKUPS[0]!.name}`,
      viewport: { width: 1440, height: 1000 },
      crop: { x: 194, y: 64, width: 1246, height: 850 },
      masks: [],
      readiness: ["today", "fonts"],
      populatedWidgets: ["Today", "Chat"],
      artifacts: {
        raw: writeArtifact("raw/a.png"),
        masked: writeArtifact("captures/a.png"),
        diff: writeArtifact("diffs/a.png"),
        controls: [writeArtifact("controls/a.changed.png")]
      },
      elapsedMs: 1,
      comparison: { outcome: "control" as const, zeroControlPercent: 0, changedControlPercent: 1 }
    };
    const guardCapture = (name: string, route: "tasks", width: 375 | 1440) => ({
      identity: `guard:${route}@${width}`,
      route,
      width,
      crop: { x: 0, y: 0, width, height: 850 },
      readiness: ["route"],
      populatedWidgets: ["route"],
      artifacts: {
        raw: writeArtifact(`raw/${name}.png`),
        capture: writeArtifact(`captures/${name}.png`),
        controls: [writeArtifact(`controls/${name}.control.png`)]
      },
      elapsedMs: 1
    });
    const manifest = {
      schema: 1 as const,
      head: "a".repeat(40),
      expectedBase: null,
      harnessDigest: computeHarnessDigest(),
      artifactRoot: "HEAD/ATTEMPT",
      fixture: { seedDate: "2026-09-17", timeZone: "America/Los_Angeles" },
      timings: { setupMs: 1, preflightMs: 1, captureMs: 1, compareMs: 1, teardownMs: 1 },
      selection: [capture.identity],
      guards: ["guard:tasks@1440", "guard:tasks@375"],
      captures: [capture],
      guardCaptures: [
        guardCapture("tasks-1440", "tasks", 1440),
        guardCapture("tasks-375", "tasks", 375)
      ]
    };
    expect(() => validateRunManifest(selection, manifest, PINNED_OPTIONS(root))).not.toThrow();
    expect(() =>
      validateRunManifest(
        selection,
        { ...manifest, captures: [capture, capture] },
        PINNED_OPTIONS(root)
      )
    ).toThrow("duplicate");
    expect(() =>
      validateRunManifest(selection, { ...manifest, captures: [] }, PINNED_OPTIONS(root))
    ).toThrow("inventory");
  });

  it("declares ordering prerequisites for every catalog state recipe", () => {
    expect(statePrerequisites("evening-step-3")).toEqual([
      "clock:evening",
      "planning:step-0",
      "planning:step-1",
      "choice:tomorrow",
      "planning:step-2",
      "planning:step-3"
    ]);
    expect(statePrerequisites("today-evening-saved")).toContain("planning:saved");
    expect(() => statePrerequisites("unknown-state")).toThrow("unsupported state recipe");
  });

  it("rejects colliding artifact directories before browser work", () => {
    const colliding = parseCaseSelection({
      version: 1,
      cases: [selectedCase],
      guards,
      artifacts: { raw: "same", captures: "same" }
    });
    expect(() => resolveCaseSelectionManifest(colliding, { mockups: MOCKUPS })).toThrow("collides");
    expect(() =>
      assertArtifactDirsDistinct({
        root: "HEAD/ATTEMPT",
        selection: "selection.json",
        manifest: "manifest.json",
        captures: "captures",
        raw: "captures",
        diffs: "diffs",
        controls: "controls",
        timings: "timings.json",
        failure: "failure"
      })
    ).toThrow("collides");
  });

  it("rejects wrong head, wrong base, changed bytes, missing files and declaration drift", () => {
    const selection = {
      mode: "selected" as const,
      entries: [MOCKUPS[0]!],
      cases: [selectedCase],
      guards,
      artifacts: {
        root: "HEAD/ATTEMPT",
        selection: "selection.json",
        manifest: "manifest.json",
        captures: "captures",
        raw: "raw",
        diffs: "diffs",
        controls: "controls",
        timings: "timings.json",
        failure: "failure"
      }
    };
    const root = mkdtempSync(join(tmpdir(), "parity-negative-"));
    writeFileSync(join(root, "selection.json"), "{}");
    writeFileSync(join(root, "manifest.json"), "{}");
    writeFileSync(join(root, "timings.json"), "{}");
    const writeArtifact = (path: string, bytes?: string) => {
      const content = bytes ?? `${path}\n`;
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
      return { path, sha256: createHash("sha256").update(content).digest("hex") };
    };
    const capture = {
      identity: `${MOCKUPS[0]!.dir}/${MOCKUPS[0]!.name}`,
      viewport: { width: 1440, height: 1000 },
      crop: { x: 194, y: 64, width: 1246, height: 850 },
      masks: [],
      readiness: ["today"],
      populatedWidgets: ["Today", "Chat"],
      artifacts: {
        raw: writeArtifact("raw/a.png"),
        masked: writeArtifact("captures/a.png"),
        diff: writeArtifact("diffs/a.png"),
        controls: [writeArtifact("controls/a.changed.png")]
      },
      elapsedMs: 1,
      comparison: { outcome: "control" as const, zeroControlPercent: 0, changedControlPercent: 1 }
    };
    const guardCapture = (name: string, route: "tasks", width: 375 | 1440) => ({
      identity: `guard:${route}@${width}`,
      route,
      width,
      crop: { x: 0, y: 0, width, height: 850 },
      readiness: ["route"],
      populatedWidgets: [route, "Chat"],
      artifacts: {
        raw: writeArtifact(`raw/${name}.png`),
        capture: writeArtifact(`captures/${name}.png`),
        controls: [writeArtifact(`controls/${name}.control.png`)]
      },
      elapsedMs: 1
    });
    const good = {
      schema: 1 as const,
      head: "a".repeat(40),
      expectedBase: null,
      harnessDigest: computeHarnessDigest(),
      artifactRoot: "HEAD/ATTEMPT",
      fixture: { seedDate: "2026-09-17", timeZone: "America/Los_Angeles" },
      timings: { setupMs: 1, preflightMs: 1, captureMs: 1, compareMs: 1, teardownMs: 1 },
      selection: [capture.identity],
      guards: ["guard:tasks@1440", "guard:tasks@375"],
      captures: [capture],
      guardCaptures: [
        guardCapture("tasks-1440", "tasks", 1440),
        guardCapture("tasks-375", "tasks", 375)
      ]
    };
    const check = (manifest: Parameters<typeof validateRunManifest>[1]) =>
      validateRunManifest(selection, manifest, PINNED_OPTIONS(root));
    expect(() => check(good)).not.toThrow();
    expect(() =>
      validateRunManifest(selection, good, PINNED_OPTIONS(root, "c".repeat(40)))
    ).toThrow("head");
    expect(() =>
      validateRunManifest(
        selection,
        { ...good, expectedBase: "d".repeat(40) },
        PINNED_OPTIONS(root)
      )
    ).toThrow("base");
    expect(() => check({ ...good, harnessDigest: "0".repeat(64) })).toThrow("trivial");
    expect(() =>
      check({ ...good, fixture: { seedDate: "tomorrow", timeZone: "America/Los_Angeles" } })
    ).toThrow("seedDate");
    expect(() =>
      check({
        ...good,
        captures: [{ ...capture, viewport: { width: 375, height: 1000 } }]
      })
    ).toThrow("viewport");
    expect(() =>
      check({ ...good, captures: [{ ...capture, crop: { ...capture.crop, x: 0 } }] })
    ).toThrow("crop");
    expect(() =>
      check({
        ...good,
        captures: [{ ...capture, comparison: { ...capture.comparison, outcome: "pass" as const } }]
      })
    ).toThrow("baseline");
    const tampered = join(root, "captures/a.png");
    writeFileSync(tampered, "changed\n");
    expect(() => check(good)).toThrow("changed");
    writeFileSync(tampered, "captures/a.png\n");
    expect(() => check(good)).not.toThrow();
    expect(() => check({ ...good, harnessDigest: "c".repeat(64) })).toThrow(
      "does not match the running harness"
    );
    expect(() =>
      check({ ...good, fixture: { seedDate: "2026-09-18", timeZone: "America/Los_Angeles" } })
    ).toThrow("seedDate");
    expect(() =>
      check({ ...good, fixture: { seedDate: "2026-09-17", timeZone: "Europe/Paris" } })
    ).toThrow("timeZone");
    expect(() =>
      check({
        ...good,
        guardCaptures: [
          { ...good.guardCaptures[0]!, crop: { x: 0, y: 0, width: 1, height: 850 } },
          good.guardCaptures[1]!
        ]
      })
    ).toThrow("guard crop");
  });

  it("performs every recipe action in declared order through observed handlers", async () => {
    const record: string[] = [];
    const handlers: SetupActionHandlers = {
      openTodayMorning: async () => {
        record.push("openToday:morning");
      },
      openTodayEvening: async () => {
        record.push("openToday:evening");
      },
      populatedMorning: async () => {
        record.push("populatedMorning");
      },
      planningStep: async (step) => {
        record.push(`planning:step-${step}`);
      },
      choiceTomorrow: async () => {
        record.push("choice:tomorrow");
      },
      planningSaved: async () => {
        record.push("planning:saved");
      },
      expectSavedText: async () => {
        record.push("expectSavedText");
      },
      closeDialogs: async () => {
        record.push("closeDialogs");
      },
      expectTodayRoute: async () => {
        record.push("expectTodayRoute");
      },
      driveState: async () => {
        record.push("driveState");
      }
    };
    // Dispatch is faithful: a skipped or reordered recipe step fails this instead of passing silently.
    for (const state of [
      "today-morning-news",
      "today-evening",
      "today-evening-saved",
      "reader-automatic-read",
      "evening-step-0",
      "evening-step-2",
      "evening-saved",
      "changed-plan-review"
    ]) {
      record.length = 0;
      await runSetupActions(state, handlers);
      expect(record).toEqual([...selectedSetupActions(state)]);
    }
    record.length = 0;
    await runSetupActions("today-evening-saved", handlers);
    expect(record.indexOf("planning:saved")).toBeLessThan(record.indexOf("closeDialogs"));
    expect(record.indexOf("expectSavedText")).toBeLessThan(record.indexOf("expectTodayRoute"));
    record.length = 0;
    await runSetupActions("today-evening", handlers);
    expect(record).toEqual(["openToday:evening"]);
    await expect(runSetupActions("unknown-state", handlers)).rejects.toThrow("unsupported");
    // Fixed expectation, not derived from selectedSetupActions: the evening-saved recipe must
    // wait for the saved-state confirmation after clicking Save, or a capture can beat the UI.
    record.length = 0;
    await runSetupActions("evening-saved", handlers);
    expect(record[record.length - 1]).toBe("expectSavedText");
    expect(record.indexOf("planning:saved")).toBeLessThan(record.indexOf("expectSavedText"));
  });

  function createValidManifestFixture() {
    const elementEntry = MOCKUPS.find((entry) => entry.region.kind === "element")!;
    const selection = {
      mode: "selected" as const,
      entries: [MOCKUPS[0]!, elementEntry],
      cases: [
        {
          dir: MOCKUPS[0]!.dir,
          name: MOCKUPS[0]!.name,
          role: "owned-region/reference" as const,
          reference: "refs/r.png",
          base: "refs/b.png"
        },
        { dir: elementEntry.dir, name: elementEntry.name, role: "measurement" as const }
      ],
      guards,
      artifacts: {
        root: "HEAD/ATTEMPT",
        selection: "selection.json",
        manifest: "manifest.json",
        captures: "captures",
        raw: "raw",
        diffs: "diffs",
        controls: "controls",
        timings: "timings.json",
        failure: "failure"
      }
    };
    const root = mkdtempSync(join(tmpdir(), "parity-selection-ref-"));
    writeFileSync(join(root, "selection.json"), "{}");
    writeFileSync(join(root, "manifest.json"), "{}");
    writeFileSync(join(root, "timings.json"), "{}");
    const writeArtifact = (path: string, bytes: string | Buffer = `${path}\n`) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), bytes);
      return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    const baseRecord = writeArtifact("refs/b.png");
    const referenceRecord = writeArtifact("refs/r.png");
    const region = MOCKUPS[0]!.region;
    if (region.kind !== "clip") throw new Error("test needs a clip entry first");
    const capture = {
      identity: `${MOCKUPS[0]!.dir}/${MOCKUPS[0]!.name}`,
      viewport: { width: 1440, height: 1000 },
      crop: { x: region.x, y: region.y, width: region.w, height: region.h },
      masks: [],
      readiness: ["today", "fonts"],
      populatedWidgets: ["Today", "Chat"],
      artifacts: {
        raw: writeArtifact("raw/a.png"),
        masked: writeArtifact("captures/a.png"),
        diff: writeArtifact("diffs/a.png"),
        controls: [writeArtifact("controls/a.changed.png")],
        referenceDiff: writeArtifact("diffs/a.reference.diff.png")
      },
      elapsedMs: 1,
      comparison: {
        outcome: "pass" as const,
        expectedBase: "e".repeat(40),
        expectedReference: "refs/r.png",
        baseSha256: baseRecord.sha256,
        referenceSha256: referenceRecord.sha256,
        zeroControlPercent: 0,
        changedControlPercent: 1
      }
    };
    const elementIdentity = `${elementEntry.dir}/${elementEntry.name}`;
    const solidPng = (width: number, height: number) => {
      const png = new PNG({ width, height });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = 10;
        png.data[i + 1] = 20;
        png.data[i + 2] = 30;
        png.data[i + 3] = 255;
      }
      return PNG.sync.write(png);
    };
    const rawArtifact = writeArtifact("raw/e.png", solidPng(200, 100));
    const sidecarData = {
      identity: elementIdentity,
      selector:
        elementEntry.region.kind === "element" ? elementEntry.region.selector : '[role="region"]',
      viewport: { width: 1440, height: 1000 },
      crop: { x: 100, y: 100, width: 200, height: 100 },
      rawSha256: rawArtifact.sha256
    };
    const geometryRecord = writeArtifact(
      "raw/e.geometry.json",
      JSON.stringify(sidecarData, null, 2)
    );
    const elementCapture = {
      identity: elementIdentity,
      viewport: { width: 1440, height: 1000 },
      crop: { x: 100, y: 100, width: 200, height: 100 },
      masks: [],
      readiness: ["today", "fonts"],
      populatedWidgets: ["Today", "Chat"],
      artifacts: {
        raw: rawArtifact,
        masked: writeArtifact("captures/e.png"),
        diff: writeArtifact("diffs/e.png"),
        controls: [writeArtifact("controls/e.changed.png")],
        geometrySidecar: geometryRecord
      },
      elapsedMs: 1,
      comparison: {
        outcome: "control" as const,
        zeroControlPercent: 0,
        changedControlPercent: 1
      }
    };
    const guardCapture = (name: string, route: "tasks", width: 375 | 1440) => ({
      identity: `guard:${route}@${width}`,
      route,
      width,
      crop: { x: 0, y: 0, width, height: 850 },
      readiness: ["route"],
      populatedWidgets: ["route"],
      artifacts: {
        raw: writeArtifact(`raw/${name}.png`),
        capture: writeArtifact(`captures/${name}.png`),
        controls: [writeArtifact(`controls/${name}.control.png`)]
      },
      elapsedMs: 1
    });
    const manifest = {
      schema: 1 as const,
      head: "a".repeat(40),
      expectedBase: "e".repeat(40),
      harnessDigest: computeHarnessDigest(),
      artifactRoot: "HEAD/ATTEMPT",
      fixture: { seedDate: "2026-09-17", timeZone: "America/Los_Angeles" },
      timings: { setupMs: 1, preflightMs: 1, captureMs: 1, compareMs: 1, teardownMs: 1 },
      selection: [capture.identity, elementIdentity],
      guards: ["guard:tasks@1440", "guard:tasks@375"],
      captures: [capture, elementCapture],
      guardCaptures: [
        guardCapture("tasks-1440", "tasks", 1440),
        guardCapture("tasks-375", "tasks", 375)
      ]
    };
    const check = (value: typeof manifest) =>
      validateRunManifest(selection, value, {
        ...PINNED_OPTIONS(root),
        expectedBase: "e".repeat(40)
      });
    return {
      root,
      selection,
      manifest,
      check,
      capture,
      elementCapture,
      elementEntry,
      sidecarData,
      writeArtifact
    };
  }

  it("binds element crops to the viewport and reference bytes to the declaration", () => {
    const { root, manifest, check, capture, elementCapture } = createValidManifestFixture();
    expect(() => check(manifest)).not.toThrow();
    // Swapped reference bytes cannot pass: the recorded hash must match the declared file, not just name it.
    writeFileSync(join(root, "refs/r.png"), "forged\n");
    expect(() => check(manifest)).toThrow("reference bytes changed");
    writeFileSync(join(root, "refs/r.png"), "refs/r.png\n");
    expect(() => check(manifest)).not.toThrow();
    expect(() =>
      check({
        ...manifest,
        captures: [
          { ...capture, comparison: { ...capture.comparison, referenceSha256: "f".repeat(64) } },
          elementCapture
        ]
      })
    ).toThrow("reference bytes changed");
    // The reference comparison diff must be inventoried and checksummed too, not dropped.
    const { referenceDiff: _referenceDiff, ...artifactsWithoutReferenceDiff } = capture.artifacts;
    expect(() =>
      check({
        ...manifest,
        captures: [
          { ...capture, artifacts: artifactsWithoutReferenceDiff } as typeof capture,
          elementCapture
        ]
      })
    ).toThrow("reference comparison diff not inventoried");
    expect(() =>
      check({
        ...manifest,
        captures: [
          {
            ...capture,
            artifacts: {
              ...capture.artifacts,
              referenceDiff: { path: "diffs/a.reference.diff.png", sha256: "f".repeat(64) }
            }
          },
          elementCapture
        ]
      })
    ).toThrow("artifact checksum changed");
    // An element crop outside the viewport cannot pass: live boxes stay bound even though their exact pixels are not predeclared.
    expect(() =>
      check({
        ...manifest,
        captures: [
          capture,
          { ...elementCapture, crop: { x: 1300, y: 100, width: 200, height: 100 } }
        ]
      })
    ).toThrow("exceeds viewport");
    // An altered but still in-bounds element crop cannot pass either: reported width/height
    // must bind to the pixels actually captured, not just fit inside the viewport.
    expect(() =>
      check({
        ...manifest,
        captures: [capture, { ...elementCapture, crop: { ...elementCapture.crop, width: 201 } }]
      })
    ).toThrow("differs from captured pixels");
  });

  it("rejects element capture when only x drifts while artifact bytes remain unchanged", () => {
    const { manifest, check, capture, elementCapture } = createValidManifestFixture();
    expect(() =>
      check({
        ...manifest,
        captures: [capture, { ...elementCapture, crop: { ...elementCapture.crop, x: 101 } }]
      })
    ).toThrow("differs from recorded geometry");
  });

  it("rejects element capture when only y drifts while artifact bytes remain unchanged", () => {
    const { manifest, check, capture, elementCapture } = createValidManifestFixture();
    expect(() =>
      check({
        ...manifest,
        captures: [capture, { ...elementCapture, crop: { ...elementCapture.crop, y: 101 } }]
      })
    ).toThrow("differs from recorded geometry");
  });

  it("rejects element capture with missing, corrupted or mismatched geometry sidecars", () => {
    const { manifest, check, capture, elementCapture, sidecarData, writeArtifact } =
      createValidManifestFixture();

    // 1. Missing sidecar
    const { geometrySidecar: _g, ...artifactsWithoutSidecar } = elementCapture.artifacts;
    expect(() =>
      check({
        ...manifest,
        captures: [
          capture,
          { ...elementCapture, artifacts: artifactsWithoutSidecar } as typeof elementCapture
        ]
      })
    ).toThrow("element capture geometry sidecar not inventoried");

    // 2. Corrupted sidecar
    const corruptedSidecar = writeArtifact("raw/e.corrupted.geometry.json", "{ invalid json");
    expect(() =>
      check({
        ...manifest,
        captures: [
          capture,
          {
            ...elementCapture,
            artifacts: { ...elementCapture.artifacts, geometrySidecar: corruptedSidecar }
          }
        ]
      })
    ).toThrow("corrupted geometry sidecar");

    // 3. Mismatched identity
    const mismatchedIdentity = writeArtifact(
      "raw/e.mismatch-identity.geometry.json",
      JSON.stringify({ ...sidecarData, identity: "other/path.png" })
    );
    expect(() =>
      check({
        ...manifest,
        captures: [
          capture,
          {
            ...elementCapture,
            artifacts: { ...elementCapture.artifacts, geometrySidecar: mismatchedIdentity }
          }
        ]
      })
    ).toThrow("geometry sidecar identity mismatch");

    // 4. Mismatched selector
    const mismatchedSelector = writeArtifact(
      "raw/e.mismatch-selector.geometry.json",
      JSON.stringify({ ...sidecarData, selector: '[role="wrong"]' })
    );
    expect(() =>
      check({
        ...manifest,
        captures: [
          capture,
          {
            ...elementCapture,
            artifacts: { ...elementCapture.artifacts, geometrySidecar: mismatchedSelector }
          }
        ]
      })
    ).toThrow("geometry sidecar selector mismatch");

    // 5. Mismatched viewport
    const mismatchedViewport = writeArtifact(
      "raw/e.mismatch-viewport.geometry.json",
      JSON.stringify({ ...sidecarData, viewport: { width: 375, height: 1000 } })
    );
    expect(() =>
      check({
        ...manifest,
        captures: [
          capture,
          {
            ...elementCapture,
            artifacts: { ...elementCapture.artifacts, geometrySidecar: mismatchedViewport }
          }
        ]
      })
    ).toThrow("geometry sidecar viewport mismatch");

    // 6. Mismatched raw image SHA256
    const mismatchedRawSha = writeArtifact(
      "raw/e.mismatch-rawsha.geometry.json",
      JSON.stringify({ ...sidecarData, rawSha256: "0".repeat(64) })
    );
    expect(() =>
      check({
        ...manifest,
        captures: [
          capture,
          {
            ...elementCapture,
            artifacts: { ...elementCapture.artifacts, geometrySidecar: mismatchedRawSha }
          }
        ]
      })
    ).toThrow("geometry sidecar raw image SHA256 mismatch");
  });

  it("compares declared reference bytes through the same comparator", () => {
    const root = mkdtempSync(join(tmpdir(), "parity-reference-"));
    const solid = (r: number, g: number, b: number) => {
      const png = new PNG({ width: 8, height: 8 });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = r;
        png.data[i + 1] = g;
        png.data[i + 2] = b;
        png.data[i + 3] = 255;
      }
      return PNG.sync.write(png);
    };
    const masked = join(root, "masked.png");
    const reference = join(root, "reference.png");
    const diff = join(root, "reference.diff.png");
    writeFileSync(masked, solid(10, 20, 30));
    writeFileSync(reference, solid(10, 20, 30));
    const same = compareReferenceCapture(masked, reference, diff);
    expect(same.percent).toBe(0);
    expect(same.sha256).toBe(
      createHash("sha256")
        .update(solid(10, 20, 30))
        .digest("hex")
    );
    writeFileSync(reference, solid(200, 210, 220));
    expect(() => compareReferenceCapture(masked, reference, diff)).toThrow("reference comparison");
    expect(() => compareReferenceCapture(masked, join(root, "missing.png"), diff)).toThrow(
      "missing declared reference"
    );
  });

  it("keeps the legacy all-case walk as the recorded failing-before behavior", () => {
    expect(MOCKUPS.length).toBe(32);
    const legacy = resolveCaseSelection({ mockups: MOCKUPS, guards });
    expect(legacy.mode).toBe("default");
    expect(legacy.entries).toHaveLength(32);
    const selected = resolveCaseSelectionManifest(
      parseCaseSelection({
        version: 1,
        cases: [
          { dir: MOCKUPS[0]!.dir, name: MOCKUPS[0]!.name, role: "measurement" },
          { dir: MOCKUPS[1]!.dir, name: MOCKUPS[1]!.name, role: "measurement" }
        ],
        guards
      }),
      { mockups: MOCKUPS }
    );
    expect(selected.entries).toHaveLength(2);
    expect(legacy.entries.length).not.toBe(selected.entries.length);
  });

  function createRegionManifestFixture() {
    const fixture = createValidManifestFixture();
    const { root, writeArtifact, selection, manifest, capture, elementCapture } = fixture;
    const regionDeclaration = parseRegionSet({
      imageSize: { width: 4, height: 4 },
      regions: [
        { id: "owned", purpose: "reference-owned", rect: { x: 0, y: 0, width: 2, height: 2 } }
      ]
    });
    // Complement pixels match everywhere so the base compare passes; the owned region differs
    // from base (proving base isn't a copy of the capture) but matches the reference instead.
    const pngWithRegion = (
      complementRgba: [number, number, number, number],
      regionRgba: [number, number, number, number]
    ) => {
      const png = new PNG({ width: 4, height: 4 });
      for (let y = 0; y < 4; y += 1)
        for (let x = 0; x < 4; x += 1) {
          const i = (4 * y + x) * 4;
          const inRegion = x < 2 && y < 2;
          const rgba = inRegion ? regionRgba : complementRgba;
          png.data[i] = rgba[0];
          png.data[i + 1] = rgba[1];
          png.data[i + 2] = rgba[2];
          png.data[i + 3] = rgba[3];
        }
      return PNG.sync.write(png);
    };
    const maskedArtifact = writeArtifact(
      "captures/region-a.png",
      pngWithRegion([10, 20, 30, 255], [40, 50, 60, 255])
    );
    const baseArtifact = writeArtifact(
      "refs/region-base.png",
      pngWithRegion([10, 20, 30, 255], [99, 98, 97, 255])
    );
    const referenceArtifact = writeArtifact(
      "refs/region-ref.png",
      pngWithRegion([1, 1, 1, 255], [40, 50, 60, 255])
    );
    const references = new Map([["owned", join(root, "refs/region-ref.png")]]);
    const freshRecord = buildRegionRunRecord(
      capture.identity,
      regionDeclaration,
      join(root, "captures/region-a.png"),
      join(root, "refs/region-base.png"),
      references,
      []
    );
    const caseWithRegions = {
      ...selection.cases[0]!,
      regions: regionDeclaration,
      reference: "refs/region-ref.png",
      base: "refs/region-base.png"
    };
    const selectionWithRegions = { ...selection, cases: [caseWithRegions, selection.cases[1]!] };
    const captureWithRegions = {
      ...capture,
      artifacts: { ...capture.artifacts, masked: maskedArtifact },
      comparison: {
        ...capture.comparison,
        expectedReference: "refs/region-ref.png",
        baseSha256: baseArtifact.sha256,
        referenceSha256: referenceArtifact.sha256,
        regionReport: freshRecord.report
      }
    };
    const manifestWithRegions = { ...manifest, captures: [captureWithRegions, elementCapture] };
    const check = (value: typeof manifestWithRegions) =>
      validateRunManifest(selectionWithRegions, value, {
        ...PINNED_OPTIONS(root),
        expectedBase: "e".repeat(40)
      });
    return {
      root,
      writeArtifact,
      selectionWithRegions,
      manifestWithRegions,
      captureWithRegions,
      elementCapture,
      regionDeclaration,
      freshRecord,
      check
    };
  }

  it("recomputes a declared region comparison from the actual base/reference bytes instead of trusting the recorded report", () => {
    const { manifestWithRegions, captureWithRegions, elementCapture, check, freshRecord } =
      createRegionManifestFixture();
    // A correctly recorded report, matching a fresh recompute, passes.
    expect(() => check(manifestWithRegions)).not.toThrow();
    // A forged report claiming a different outcome than the real bytes produce must be rejected.
    const forgedReport = {
      ...freshRecord.report,
      regions: [{ ...freshRecord.report.regions[0]!, purpose: "behavior-changed" as const }]
    };
    expect(() =>
      check({
        ...manifestWithRegions,
        captures: [
          {
            ...captureWithRegions,
            comparison: { ...captureWithRegions.comparison, regionReport: forgedReport }
          },
          elementCapture
        ]
      })
    ).toThrow("does not match a fresh recompute of the actual bytes");
    // A capture declaring regions but never recording a region report must be rejected.
    const { regionReport: _dropped, ...comparisonWithoutReport } = captureWithRegions.comparison;
    expect(() =>
      check({
        ...manifestWithRegions,
        captures: [
          {
            ...captureWithRegions,
            comparison: comparisonWithoutReport as typeof captureWithRegions.comparison
          },
          elementCapture
        ]
      })
    ).toThrow("region comparison report not recorded");
  });

  it("rejects a declared base that is byte-identical to the capture itself", () => {
    const { root, manifestWithRegions, check, writeArtifact } = createRegionManifestFixture();
    // Overwrite the declared base file so it is now the exact same bytes as
    // the masked capture: a case cannot prove anything by comparing itself
    // to itself.
    const maskedBytes = readFileSync(join(root, "captures/region-a.png"));
    writeArtifact("refs/region-base.png", maskedBytes);
    expect(() => check(manifestWithRegions)).toThrow(/self-comparison/);
  });

  it("rejects a case that declares both regions and a size transition", () => {
    expect(() =>
      parseCaseSelection({
        version: 1,
        cases: [
          {
            dir: MOCKUPS[0]!.dir,
            name: MOCKUPS[0]!.name,
            role: "owned-region/reference",
            reference: "refs/r.png",
            base: "refs/b.png",
            regions: {
              imageSize: { width: 4, height: 4 },
              regions: [
                {
                  id: "owned",
                  purpose: "reference-owned",
                  rect: { x: 0, y: 0, width: 2, height: 2 }
                }
              ]
            },
            sizeTransition: {
              oldSize: { width: 4, height: 4 },
              targetSize: { width: 4, height: 6 },
              expectedGeometry: { x: 0, y: 0 },
              regions: [
                {
                  id: "t",
                  kind: "translate",
                  purpose: "behavior-changed",
                  behaviorEvidence: "manual",
                  baseRect: { x: 0, y: 0, width: 4, height: 4 },
                  headRect: { x: 0, y: 0, width: 4, height: 4 }
                },
                {
                  id: "grown",
                  kind: "new-band",
                  purpose: "behavior-changed",
                  behaviorEvidence: "manual",
                  headRect: { x: 0, y: 4, width: 4, height: 2 }
                }
              ]
            }
          }
        ],
        guards
      })
    ).toThrow("cannot declare both regions and sizeTransition");
  });
});
