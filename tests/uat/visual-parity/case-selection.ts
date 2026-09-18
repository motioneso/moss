import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, normalize, posix, win32 } from "node:path";

import { PNG } from "pngjs";

import type { MockupEntry } from "./mockups.js";
import {
  buildRegionRunRecord,
  buildTransitionRunRecord,
  parseRegionSet,
  parseSizeTransition,
  type RegionSetComparisonReport,
  type RegionSetDeclaration,
  type SizeTransitionComparisonReport,
  type SizeTransitionDeclaration
} from "./region-comparison.js";

export const CASE_SELECTION_VERSION = 1 as const;
// Files whose bytes define the harness identity. The writer hashes exactly
// these files; validation recomputes over the same list, so a manifest digest
// only passes when it describes the tree that actually ran (pinned to the
// reviewed commit through manifest.head).
export const HARNESS_FILES = [
  "tests/uat/visual-parity/case-selection.ts",
  "tests/uat/visual-parity/capture.ts",
  "tests/uat/specs/visual-parity.uat.spec.ts",
  "tests/uat/visual-parity/region-comparison.ts",
  "tests/uat/visual-parity/region-schema.ts"
] as const;

export function computeHarnessDigest(files: readonly string[] = HARNESS_FILES): string {
  const digest = createHash("sha256");
  for (const file of files) digest.update(readFileSync(file));
  return digest.digest("hex");
}
export const COMPARISON_ROLES = ["measurement", "owned-region/reference", "base-guard"] as const;
export type ComparisonRole = (typeof COMPARISON_ROLES)[number];

export interface SelectedCase {
  readonly dir: string;
  readonly name: string;
  readonly role: ComparisonRole;
  readonly reference?: string;
  readonly base?: string;
  // Optional regional/transition declarations (VP-REGIONS-R1). Predeclared
  // geometry only; never inferred from an observed diff. Legacy cases that
  // declare neither keep the pre-existing whole-image behavior unchanged.
  readonly regions?: RegionSetDeclaration;
  readonly sizeTransition?: SizeTransitionDeclaration;
}

export interface SelectedGuard {
  readonly route: "tasks" | "calendar" | "settings" | "today";
  readonly path: "/tasks" | "/calendar" | "/settings" | "/today";
  readonly width: 375 | 1440;
  readonly role: ComparisonRole;
}

export interface ArtifactLayout {
  readonly root: string;
  readonly selection: string;
  readonly manifest: string;
  readonly captures: string;
  readonly raw: string;
  readonly diffs: string;
  readonly controls: string;
  readonly timings: string;
  readonly failure: string;
}

export interface CaseSelectionManifest {
  readonly version: 1;
  readonly cases: readonly SelectedCase[];
  readonly guards: readonly SelectedGuard[];
  readonly artifacts?: Partial<ArtifactLayout>;
}

export interface CaseSelection {
  readonly mode: "default" | "selected";
  readonly entries: readonly MockupEntry[];
  readonly cases: readonly SelectedCase[];
  readonly guards: readonly SelectedGuard[];
  readonly artifacts: ArtifactLayout;
}

export interface ElementGeometrySidecar {
  readonly identity: string;
  readonly selector: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly crop: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly rawSha256: string;
}

export interface CaptureAccounting {
  readonly identity: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly crop: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly masks: readonly string[];
  readonly readiness: readonly string[];
  readonly populatedWidgets: readonly string[];
  readonly artifacts: {
    readonly raw: ArtifactRecord;
    readonly masked: ArtifactRecord;
    readonly diff: ArtifactRecord;
    readonly controls: readonly ArtifactRecord[];
    // Present only when a reference is declared: compareReferenceCapture
    // writes this diff separately from the base diff above.
    readonly referenceDiff?: ArtifactRecord;
    // Present for element captures: records capture-time geometry sidecar
    readonly geometrySidecar?: ArtifactRecord;
    readonly geometry?: ArtifactRecord;
  };
  readonly elapsedMs: number;
  readonly comparison: {
    readonly outcome: "pass" | "fail" | "control" | "not-applicable";
    readonly expectedBase?: string;
    readonly expectedReference?: string;
    readonly baseSha256?: string;
    readonly referenceSha256?: string;
    readonly zeroControlPercent: number;
    readonly changedControlPercent: number;
    // Present only when this case declared regions/sizeTransition: the exact
    // report from the shared comparator, not a re-derived summary.
    readonly regionReport?: RegionSetComparisonReport;
    readonly transitionReport?: SizeTransitionComparisonReport;
  };
}

export interface GuardAccounting {
  readonly identity: string;
  readonly route: SelectedGuard["route"];
  readonly width: SelectedGuard["width"];
  readonly crop: CaptureAccounting["crop"];
  readonly readiness: readonly string[];
  readonly populatedWidgets: readonly string[];
  readonly artifacts: {
    readonly raw: ArtifactRecord;
    readonly capture: ArtifactRecord;
    readonly controls: readonly ArtifactRecord[];
  };
  readonly elapsedMs: number;
}

export interface ArtifactRecord {
  readonly path: string;
  readonly sha256: string;
}

export interface ParityRunManifest {
  readonly schema: 1;
  readonly head: string;
  readonly expectedBase: string | null;
  readonly harnessDigest: string;
  readonly artifactRoot: string;
  readonly fixture: { readonly seedDate: string; readonly timeZone: string };
  readonly timings: {
    readonly setupMs: number;
    readonly preflightMs: number;
    readonly captureMs: number;
    readonly compareMs: number;
    readonly teardownMs: number;
  };
  readonly selection: readonly string[];
  readonly guards: readonly string[];
  readonly captures: readonly CaptureAccounting[];
  readonly guardCaptures: readonly GuardAccounting[];
}

const DEFAULT_ARTIFACTS: ArtifactLayout = {
  root: "HEAD/ATTEMPT",
  selection: "selection.json",
  manifest: "manifest.json",
  captures: "captures",
  raw: "raw",
  diffs: "diffs",
  controls: "controls",
  timings: "timings.json",
  failure: "failure"
};
const ROUTES = ["tasks", "calendar", "settings", "today"] as const;
const WIDTHS = [375, 1440] as const;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function caseIdentity(value: Pick<SelectedCase, "dir" | "name">): string {
  return `${value.dir}/${value.name}`;
}

export function guardIdentity(value: Pick<SelectedGuard, "route" | "width">): string {
  return `guard:${value.route}@${value.width}`;
}

// Looks up the declaration for one capture in selected mode; undefined in
// default mode. Throws if selected mode has no matching declaration, so an
// undeclared capture can never silently skip accounting.
export function resolveSelectedCase(
  selection: CaseSelection,
  dir: string,
  name: string
): SelectedCase | undefined {
  if (selection.mode !== "selected") return undefined;
  const found = selection.cases.find((c) => c.dir === dir && c.name === name);
  if (!found) fail(`undeclared capture ${dir}/${name}`);
  return found;
}

// A whole-image reference-owned case has no complement and keeps the legacy
// whole-capture diff assertion; regions/sizeTransition cases record their own
// pass/fail in the comparison report instead.
export function isWholeImageOwnership(declaration: SelectedCase): boolean {
  return (
    declaration.role === "owned-region/reference" &&
    !declaration.regions &&
    !declaration.sizeTransition
  );
}

export function statePrerequisites(state: string): readonly string[] {
  if (state.startsWith("today-morning")) return ["clock:morning", "today:populated"];
  if (state === "today-evening" || state === "today-evening-saved")
    return state === "today-evening-saved"
      ? ["clock:evening", "planning:steps-0..3", "planning:saved"]
      : ["clock:evening", "today:populated"];
  if (state.startsWith("reader-")) return ["clock:morning", "reader:opened", "reader:tab-selected"];
  if (state === "evening-step-0") return ["clock:evening", "planning:step-0"];
  if (state === "evening-step-1") return ["clock:evening", "planning:step-0", "planning:step-1"];
  if (state === "evening-step-2")
    return [
      "clock:evening",
      "planning:step-0",
      "planning:step-1",
      "choice:tomorrow",
      "planning:step-2"
    ];
  if (state === "evening-step-3" || state === "changed-plan-review")
    return [
      "clock:evening",
      "planning:step-0",
      "planning:step-1",
      "choice:tomorrow",
      "planning:step-2",
      "planning:step-3"
    ];
  if (state === "evening-saved") return [...statePrerequisites("evening-step-3"), "planning:saved"];
  fail(`unsupported state recipe ${state}`);
}

function fail(message: string): never {
  throw new Error(`parity case selection: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} must be nonempty`);
  return value;
}

// Re-labels a region/transition parse failure with the owning case's field
// path, so a bad declaration still points at the exact case that made it.
function wrapFail<T>(run: () => T, label: string): T {
  try {
    return run();
  } catch (error) {
    fail(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function role(value: unknown, label: string): ComparisonRole {
  if (typeof value !== "string" || !(COMPARISON_ROLES as readonly string[]).includes(value))
    fail(`${label} must be one of ${COMPARISON_ROLES.join(", ")}`);
  return value as ComparisonRole;
}

function safeRelativePath(value: string, label: string): string {
  if (
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    value.includes("\\") ||
    value.includes("\0") ||
    normalize(value)
      .split(/[\\/]+/)
      .includes("..") ||
    value.startsWith("/")
  )
    fail(`${label} is unsafe: ${value}`);
  const normalized = posix.normalize(value);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    !normalized.split("/").every((segment) => SAFE_SEGMENT.test(segment))
  )
    fail(`${label} is unsafe: ${value}`);
  return normalized;
}

function artifactLayout(value: unknown): ArtifactLayout {
  const input = value === undefined ? {} : object(value, "artifacts");
  const output = {} as Record<keyof ArtifactLayout, string>;
  for (const key of Object.keys(DEFAULT_ARTIFACTS) as Array<keyof ArtifactLayout>) {
    const candidate = input[key];
    const selected =
      candidate === undefined ? DEFAULT_ARTIFACTS[key] : string(candidate, `artifacts.${key}`);
    output[key] = safeRelativePath(selected, `artifacts.${key}`) as never;
  }
  const seen = new Map<string, string>();
  for (const key of Object.keys(DEFAULT_ARTIFACTS) as Array<keyof ArtifactLayout>) {
    const prior = seen.get(output[key]);
    if (prior) fail(`artifacts.${key} collides with artifacts.${prior}: ${output[key]}`);
    seen.set(output[key], key);
  }
  return output as ArtifactLayout;
}

export function assertArtifactDirsDistinct(layout: ArtifactLayout): void {
  const entries = Object.entries(layout) as Array<[keyof ArtifactLayout, string]>;
  const seen = new Map<string, string>();
  for (const [key, value] of entries) {
    const prior = seen.get(value);
    if (prior) fail(`artifacts.${key} collides with artifacts.${prior}: ${value}`);
    seen.set(value, key);
  }
}

function parseCase(value: unknown, index: number): SelectedCase {
  const input = object(value, `cases[${index}]`);
  const reference =
    input.reference === undefined
      ? undefined
      : safeRelativePath(
          string(input.reference, `cases[${index}].reference`),
          `cases[${index}].reference`
        );
  const base =
    input.base === undefined
      ? undefined
      : safeRelativePath(string(input.base, `cases[${index}].base`), `cases[${index}].base`);
  const regions =
    input.regions === undefined
      ? undefined
      : wrapFail(() => parseRegionSet(input.regions), `cases[${index}].regions`);
  const sizeTransition =
    input.sizeTransition === undefined
      ? undefined
      : wrapFail(() => parseSizeTransition(input.sizeTransition), `cases[${index}].sizeTransition`);
  const selected = {
    dir: string(input.dir, `cases[${index}].dir`),
    name: string(input.name, `cases[${index}].name`),
    role: role(input.role, `cases[${index}].role`),
    ...(reference === undefined ? {} : { reference }),
    ...(base === undefined ? {} : { base }),
    ...(regions === undefined ? {} : { regions }),
    ...(sizeTransition === undefined ? {} : { sizeTransition })
  };
  if (selected.role === "measurement" && selected.base !== undefined)
    fail(`cases[${index}] measurement cannot declare a base comparison`);
  if (selected.role === "owned-region/reference" && (!selected.reference || !selected.base))
    fail(`cases[${index}] owned-region/reference requires reference and base artifacts`);
  if (selected.role === "base-guard" && !selected.base)
    fail(`cases[${index}] base-guard requires a base artifact`);
  if (selected.regions !== undefined && selected.sizeTransition !== undefined)
    fail(`cases[${index}] cannot declare both regions and sizeTransition`);
  return selected;
}

function parseGuard(value: unknown, index: number): SelectedGuard {
  const input = object(value, `guards[${index}]`);
  const route = string(input.route, `guards[${index}].route`);
  const path = string(input.path, `guards[${index}].path`);
  const width = input.width;
  if (!(ROUTES as readonly string[]).includes(route) || path !== `/${route}`)
    fail(`guards[${index}] has contradictory route/path identity`);
  if (!WIDTHS.includes(width as (typeof WIDTHS)[number]))
    fail(`guards[${index}].width is unsupported`);
  const guardRole = role(input.role, `guards[${index}].role`);
  if (guardRole !== "base-guard") fail(`guards[${index}] must use the base-guard role`);
  return {
    route: route as SelectedGuard["route"],
    path: path as SelectedGuard["path"],
    width: width as SelectedGuard["width"],
    role: guardRole
  };
}

export function parseCaseSelection(value: unknown): CaseSelectionManifest {
  const input = object(value, "manifest");
  if (input.version !== CASE_SELECTION_VERSION) fail("version must be 1");
  if (!Array.isArray(input.cases) || input.cases.length === 0) fail("cases must be nonempty");
  if (!Array.isArray(input.guards) || input.guards.length === 0) fail("guards must be nonempty");
  const cases = input.cases.map(parseCase);
  const guards = input.guards.map(parseGuard);
  const caseIds = new Set<string>();
  for (const selected of cases) {
    const id = caseIdentity(selected);
    if (caseIds.has(id)) fail(`duplicate case identity: ${id}`);
    caseIds.add(id);
  }
  const guardIds = new Set<string>();
  for (const guard of guards) {
    const id = `${guard.route}@${guard.width}`;
    if (guardIds.has(id)) fail(`duplicate guard identity: ${id}`);
    guardIds.add(id);
  }
  return {
    version: 1,
    cases,
    guards,
    artifacts: input.artifacts as Partial<ArtifactLayout> | undefined
  };
}

export function loadCaseSelection(path: string): CaseSelectionManifest {
  if (!path) fail("manifest path is empty");
  if (!isAbsolute(path) && !win32.isAbsolute(path)) fail("manifest path must be absolute");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    fail(`cannot read manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseCaseSelection(value);
}

export function resolveCaseSelection(input: {
  readonly manifestPath?: string;
  readonly parityOwned?: string;
  readonly parityShell?: boolean;
  readonly guardOnly?: boolean;
  readonly mockups: readonly MockupEntry[];
  readonly guards: readonly SelectedGuard[];
}): CaseSelection {
  if (!input.manifestPath) {
    return {
      mode: "default",
      entries: input.mockups,
      cases: [],
      guards: input.guards,
      artifacts: DEFAULT_ARTIFACTS
    };
  }
  if (input.parityOwned?.trim()) fail("PARITY_CASE_MANIFEST conflicts with PARITY_OWNED");
  if (input.parityShell) fail("PARITY_CASE_MANIFEST conflicts with PARITY_SHELL");
  if (input.guardOnly) fail("PARITY_CASE_MANIFEST conflicts with PARITY_GUARD_ONLY");
  return resolveCaseSelectionManifest(loadCaseSelection(input.manifestPath), input);
}

export function resolveCaseSelectionManifest(
  manifest: CaseSelectionManifest,
  input: Pick<Parameters<typeof resolveCaseSelection>[0], "mockups">
): CaseSelection {
  const byIdentity = new Map(input.mockups.map((entry) => [`${entry.dir}/${entry.name}`, entry]));
  const entries = manifest.cases.map((selected) => {
    const entry = byIdentity.get(caseIdentity(selected));
    if (!entry) fail(`unknown case identity: ${caseIdentity(selected)}`);
    return entry;
  });
  if (entries.length > 1 && entries[0]?.viewport.w !== 1440)
    fail("the first selected case must be the desktop smoke case");
  const artifacts = artifactLayout(manifest.artifacts);
  assertArtifactDirsDistinct(artifacts);
  return { mode: "selected", entries, cases: manifest.cases, guards: manifest.guards, artifacts };
}

export function selectedSetupActions(state: string): readonly string[] {
  if (state.startsWith("today-morning")) return ["openToday:morning", "populatedMorning"];
  if (state === "today-evening") return ["openToday:evening"];
  if (state === "today-evening-saved")
    return [
      "openToday:evening",
      "planning:step-0",
      "planning:step-1",
      "choice:tomorrow",
      "planning:step-2",
      "planning:step-3",
      "planning:saved",
      "expectSavedText",
      "closeDialogs",
      "expectTodayRoute"
    ];
  if (state.startsWith("reader-")) return ["openToday:morning", "driveState"];
  if (state === "evening-step-0") return ["openToday:evening", "planning:step-0"];
  if (state === "evening-step-1")
    return ["openToday:evening", "planning:step-0", "planning:step-1"];
  if (state === "evening-step-2")
    return [
      "openToday:evening",
      "planning:step-0",
      "planning:step-1",
      "choice:tomorrow",
      "planning:step-2"
    ];
  if (state === "evening-step-3" || state === "changed-plan-review")
    return [
      "openToday:evening",
      "planning:step-0",
      "planning:step-1",
      "choice:tomorrow",
      "planning:step-2",
      "planning:step-3"
    ];
  if (state === "evening-saved")
    return [
      "openToday:evening",
      "planning:step-0",
      "planning:step-1",
      "choice:tomorrow",
      "planning:step-2",
      "planning:step-3",
      "planning:saved",
      "expectSavedText"
    ];
  fail(`unsupported state recipe ${state}`);
}

export interface SetupActionHandlers {
  readonly openTodayMorning: () => Promise<void>;
  readonly openTodayEvening: () => Promise<void>;
  readonly populatedMorning: () => Promise<void>;
  readonly planningStep: (step: 0 | 1 | 2 | 3) => Promise<void>;
  readonly choiceTomorrow: () => Promise<void>;
  readonly planningSaved: () => Promise<void>;
  readonly expectSavedText: () => Promise<void>;
  readonly closeDialogs: () => Promise<void>;
  readonly expectTodayRoute: () => Promise<void>;
  readonly driveState: () => Promise<void>;
}

// Executes a state's recipe through injected handlers in declared order.
// Production wires the real browser helpers; tests record the dispatch, so a
// recipe can only pass when every action is performed and observed.
export async function runSetupActions(state: string, handlers: SetupActionHandlers): Promise<void> {
  for (const action of selectedSetupActions(state)) {
    if (action === "openToday:morning") await handlers.openTodayMorning();
    else if (action === "openToday:evening") await handlers.openTodayEvening();
    else if (action === "populatedMorning") await handlers.populatedMorning();
    else if (action === "choice:tomorrow") await handlers.choiceTomorrow();
    else if (action === "planning:saved") await handlers.planningSaved();
    else if (action === "expectSavedText") await handlers.expectSavedText();
    else if (action === "closeDialogs") await handlers.closeDialogs();
    else if (action === "expectTodayRoute") await handlers.expectTodayRoute();
    else if (action === "driveState") await handlers.driveState();
    else if (action.startsWith("planning:step-")) {
      const step = Number(action.slice("planning:step-".length));
      if (step !== 0 && step !== 1 && step !== 2 && step !== 3)
        fail(`unsupported setup action ${action}`);
      await handlers.planningStep(step);
    } else fail(`unsupported setup action ${action}`);
  }
}

export function validateRunManifest(
  selection: CaseSelection,
  manifest: ParityRunManifest,
  options: {
    readonly artifactRoot: string;
    readonly expectedHead: string;
    readonly expectedBase: string | null;
    readonly expectedHarnessFiles: readonly string[];
    readonly expectedFixture: { readonly seedDate: string; readonly timeZone: string };
  }
): void {
  if (manifest.schema !== 1) fail("run manifest schema must be 1");
  if (!/^[0-9a-f]{40,64}$/i.test(manifest.head)) fail("run manifest head must be a full git SHA");
  if (manifest.expectedBase !== null && !/^[0-9a-f]{40,64}$/i.test(manifest.expectedBase))
    fail("run manifest base must be a full git SHA or null");
  if (!/^[0-9a-f]{64}$/i.test(manifest.harnessDigest))
    fail("run manifest harnessDigest must be SHA256");
  if (/^0{64}$/i.test(manifest.harnessDigest)) fail("run manifest harnessDigest is trivial");
  const actualHarnessDigest = computeHarnessDigest(options.expectedHarnessFiles);
  if (manifest.harnessDigest !== actualHarnessDigest)
    fail("run manifest harnessDigest does not match the running harness files");
  if (manifest.fixture.seedDate !== options.expectedFixture.seedDate)
    fail("run manifest seedDate does not match the pinned fixture date");
  if (manifest.fixture.timeZone !== options.expectedFixture.timeZone)
    fail("run manifest timeZone does not match the pinned fixture zone");
  if (manifest.head !== options.expectedHead)
    fail("run manifest head does not match the running head");
  if (manifest.expectedBase !== options.expectedBase)
    fail("run manifest base does not match the declared base");
  if (manifest.artifactRoot !== selection.artifacts.root)
    fail("run manifest artifact root differs from declaration");
  for (const [key, value] of Object.entries(manifest.timings))
    if (!Number.isFinite(value) || value < 0) fail(`invalid ${key} timing`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.fixture.seedDate))
    fail("run manifest seedDate must be YYYY-MM-DD");
  if (!manifest.fixture.timeZone || !manifest.fixture.timeZone.includes("/"))
    fail("run manifest timeZone must be a region/city zone");
  const expected = selection.cases.map(caseIdentity);
  if (JSON.stringify(manifest.selection) !== JSON.stringify(expected))
    fail("run manifest selection differs from declaration");
  const expectedGuards = selection.guards.map(guardIdentity);
  if (JSON.stringify(manifest.guards) !== JSON.stringify(expectedGuards))
    fail("run manifest guard inventory differs from declaration");
  if (manifest.guardCaptures.length !== expectedGuards.length)
    fail("run manifest guard capture inventory differs from declaration");
  const paths = new Set<string>();
  const checkArtifact = (artifact: ArtifactRecord, label: string): void => {
    safeRelativePath(artifact.path, `${label}.path`);
    if (!/^[0-9a-f]{64}$/i.test(artifact.sha256)) fail(`invalid artifact SHA256 for ${label}`);
    if (paths.has(artifact.path)) fail(`artifact path collision: ${artifact.path}`);
    paths.add(artifact.path);
    const absolute = `${options.artifactRoot}/${artifact.path}`;
    if (!existsSync(absolute)) fail(`missing artifact: ${artifact.path}`);
    const actual = createHash("sha256").update(readFileSync(absolute)).digest("hex");
    if (actual !== artifact.sha256) fail(`artifact checksum changed: ${artifact.path}`);
  };
  for (const file of [
    selection.artifacts.selection,
    selection.artifacts.manifest,
    selection.artifacts.timings
  ]) {
    if (!existsSync(`${options.artifactRoot}/${file}`)) fail(`missing durable file: ${file}`);
  }
  const needsBase = selection.cases.some((candidate) => candidate.base);
  if (needsBase && manifest.expectedBase === null)
    fail("run manifest base is missing for a declared base comparison");
  if (!needsBase && manifest.expectedBase !== null)
    fail("run manifest base must be null without a declared base comparison");
  for (const declaration of selection.cases) {
    if (declaration.base) {
      safeRelativePath(declaration.base, `${caseIdentity(declaration)}.base`);
      if (!existsSync(`${options.artifactRoot}/${declaration.base}`))
        fail(`missing declared baseline: ${declaration.base}`);
    }
    if (declaration.reference) {
      safeRelativePath(declaration.reference, `${caseIdentity(declaration)}.reference`);
      if (!existsSync(`${options.artifactRoot}/${declaration.reference}`))
        fail(`missing declared reference: ${declaration.reference}`);
    }
  }
  const actual = new Map<string, CaptureAccounting>();
  for (const capture of manifest.captures) {
    if (actual.has(capture.identity)) fail(`duplicate capture identity: ${capture.identity}`);
    actual.set(capture.identity, capture);
    for (const [key, artifact] of Object.entries(capture.artifacts)) {
      if (artifact === undefined) continue;
      if (key === "controls") {
        for (const [index, control] of (artifact as readonly ArtifactRecord[]).entries())
          checkArtifact(control as ArtifactRecord, `${capture.identity}.controls[${index}]`);
      } else checkArtifact(artifact as ArtifactRecord, `${capture.identity}.${key}`);
    }
    if (!Number.isFinite(capture.elapsedMs) || capture.elapsedMs < 0)
      fail(`invalid elapsed time for ${capture.identity}`);
    if (capture.comparison.outcome === "pass" || capture.comparison.outcome === "fail") {
      if (!capture.comparison.expectedBase) fail(`missing baseline for ${capture.identity}`);
      if (!/^[0-9a-f]{40,64}$/i.test(capture.comparison.expectedBase))
        fail(`invalid baseline SHA for ${capture.identity}`);
      if (capture.comparison.expectedBase !== manifest.expectedBase)
        fail(`capture baseline differs from run baseline: ${capture.identity}`);
    } else if (capture.comparison.expectedBase || capture.comparison.expectedReference) {
      fail(`control comparison cannot declare a baseline for ${capture.identity}`);
    }
    if (
      capture.comparison.zeroControlPercent !== 0 ||
      capture.comparison.changedControlPercent <= 0
    )
      fail(`comparison controls did not exercise the comparator for ${capture.identity}`);
    const declaration = selection.cases.find(
      (candidate) => caseIdentity(candidate) === capture.identity
    );
    if (!declaration) fail(`capture is not declared: ${capture.identity}`);
    const entry = selection.entries.find(
      (candidate) => `${candidate.dir}/${candidate.name}` === capture.identity
    );
    if (!entry) fail(`capture has no catalog entry: ${capture.identity}`);
    if (capture.viewport.width !== entry.viewport.w || capture.viewport.height !== entry.viewport.h)
      fail(`capture viewport differs from declaration: ${capture.identity}`);
    const region = entry.region;
    for (const [key, value] of Object.entries(capture.crop)) {
      if (!Number.isFinite(value) || value < 0)
        fail(`capture crop ${key} invalid: ${capture.identity}`);
    }
    if (capture.crop.width === 0 || capture.crop.height === 0)
      fail(`capture crop is empty: ${capture.identity}`);
    if (region.kind === "clip") {
      const expectedWidth = region.crop?.w ?? region.w;
      const expectedHeight = region.crop?.h ?? region.h;
      const expectedX = region.crop
        ? region.x + Math.floor((region.w - region.crop.w) / 2)
        : region.x;
      const expectedY = region.crop
        ? region.y + Math.floor((region.h - region.crop.h) / 2)
        : region.y;
      if (
        capture.crop.width !== expectedWidth ||
        capture.crop.height !== expectedHeight ||
        capture.crop.x !== expectedX ||
        capture.crop.y !== expectedY
      )
        fail(`capture crop differs from declaration: ${capture.identity}`);
    } else if (region.kind === "element") {
      if (!region.selector.trim()) fail(`capture element selector missing: ${capture.identity}`);
      if (
        capture.crop.x + capture.crop.width > capture.viewport.width ||
        capture.crop.y + capture.crop.height > capture.viewport.height
      )
        fail(`capture crop exceeds viewport: ${capture.identity}`);
      const rawAbsolute = `${options.artifactRoot}/${capture.artifacts.raw.path}`;
      const rawPixels = PNG.sync.read(readFileSync(rawAbsolute));
      if (rawPixels.width !== capture.crop.width || rawPixels.height !== capture.crop.height)
        fail(`capture crop differs from captured pixels: ${capture.identity}`);
      const sidecar = capture.artifacts.geometrySidecar ?? capture.artifacts.geometry;
      if (!sidecar) fail(`element capture geometry sidecar not inventoried: ${capture.identity}`);
      const sidecarAbsolute = `${options.artifactRoot}/${sidecar.path}`;
      let sidecarData: ElementGeometrySidecar;
      try {
        sidecarData = JSON.parse(readFileSync(sidecarAbsolute, "utf-8")) as ElementGeometrySidecar;
      } catch {
        fail(`corrupted geometry sidecar: ${capture.identity}`);
      }
      if (!sidecarData || typeof sidecarData !== "object")
        fail(`corrupted geometry sidecar: ${capture.identity}`);
      if (sidecarData.identity !== capture.identity)
        fail(`geometry sidecar identity mismatch: ${capture.identity}`);
      if (sidecarData.selector !== region.selector)
        fail(`geometry sidecar selector mismatch: ${capture.identity}`);
      if (
        !sidecarData.viewport ||
        sidecarData.viewport.width !== capture.viewport.width ||
        sidecarData.viewport.height !== capture.viewport.height
      )
        fail(`geometry sidecar viewport mismatch: ${capture.identity}`);
      if (sidecarData.rawSha256 !== capture.artifacts.raw.sha256)
        fail(`geometry sidecar raw image SHA256 mismatch: ${capture.identity}`);
      if (
        !sidecarData.crop ||
        capture.crop.x !== sidecarData.crop.x ||
        capture.crop.y !== sidecarData.crop.y ||
        capture.crop.width !== sidecarData.crop.width ||
        capture.crop.height !== sidecarData.crop.height
      )
        fail(`capture crop differs from recorded geometry: ${capture.identity}`);
    }
    if (capture.readiness.length === 0 || capture.populatedWidgets.length === 0)
      fail(`capture evidence is incomplete for ${capture.identity}`);
    // A case that declares regions or a size transition must prove its
    // comparison actually ran against the real declared base, not just claim
    // a report object. We never trust the recorded report as its own proof.
    // Instead we re-read the declared base file's bytes from disk right now
    // and re-run the whole comparison, then require the fresh result to
    // match the recorded one exactly. There is no separate "base manifest"
    // artifact to check the base against — recomputing hash-for-hash from
    // the actual declared base file already binds provenance, because a
    // forged or stale base would either fail to exist, or would exist but
    // produce a different report than the one that was recorded.
    if (declaration.regions || declaration.sizeTransition) {
      if (!declaration.base)
        fail(`capture with regions/sizeTransition requires a base: ${capture.identity}`);
      const maskedAbsolute = `${options.artifactRoot}/${capture.artifacts.masked.path}`;
      const baseAbsolute = `${options.artifactRoot}/${declaration.base}`;
      if (!existsSync(baseAbsolute)) fail(`missing declared baseline: ${capture.identity}`);
      const baseActual = createHash("sha256").update(readFileSync(baseAbsolute)).digest("hex");
      // A capture can never prove anything by being compared to itself: the
      // declared base must be different bytes from the capture under test.
      if (baseActual === capture.artifacts.masked.sha256)
        fail(
          `declared base is identical to the capture itself (self-comparison): ${capture.identity}`
        );
      const referenceAbsolute = declaration.reference
        ? `${options.artifactRoot}/${declaration.reference}`
        : undefined;
      if (declaration.regions) {
        if (!capture.comparison.regionReport)
          fail(`region comparison report not recorded: ${capture.identity}`);
        const referencePaths = new Map<string, string>();
        if (referenceAbsolute)
          for (const region of declaration.regions.regions)
            if (region.purpose === "reference-owned")
              referencePaths.set(region.id, referenceAbsolute);
        const fresh = buildRegionRunRecord(
          capture.identity,
          declaration.regions,
          maskedAbsolute,
          baseAbsolute,
          referencePaths,
          []
        );
        if (JSON.stringify(fresh.report) !== JSON.stringify(capture.comparison.regionReport))
          fail(
            `recorded region comparison does not match a fresh recompute of the actual bytes: ${capture.identity}`
          );
      }
      if (declaration.sizeTransition) {
        if (!capture.comparison.transitionReport)
          fail(`size transition comparison report not recorded: ${capture.identity}`);
        const referencePaths = new Map<string, string>();
        if (referenceAbsolute)
          for (const region of declaration.sizeTransition.regions)
            if (
              region.referenceRect ||
              (region.kind === "new-band" && region.purpose === "reference-owned")
            )
              referencePaths.set(region.id, referenceAbsolute);
        const fresh = buildTransitionRunRecord(
          capture.identity,
          declaration.sizeTransition,
          maskedAbsolute,
          baseAbsolute,
          referencePaths,
          []
        );
        if (JSON.stringify(fresh.report) !== JSON.stringify(capture.comparison.transitionReport))
          fail(
            `recorded size transition comparison does not match a fresh recompute of the actual bytes: ${capture.identity}`
          );
      }
    }
    if (declaration.role === "measurement" && capture.comparison.outcome !== "control")
      fail(`measurement cannot claim parity: ${capture.identity}`);
    if (declaration.role === "measurement" && capture.comparison.baseSha256)
      fail(`measurement cannot bind base bytes: ${capture.identity}`);
    if (declaration.role === "owned-region/reference") {
      if (capture.comparison.outcome === "control")
        fail(`owned-region/reference must compare against its base: ${capture.identity}`);
      if (capture.comparison.expectedReference !== declaration.reference)
        fail(`capture reference differs from declaration: ${capture.identity}`);
      if (!capture.comparison.baseSha256 || !/^[0-9a-f]{64}$/i.test(capture.comparison.baseSha256))
        fail(`capture base bytes unbound: ${capture.identity}`);
      const baseAbsolute = `${options.artifactRoot}/${declaration.base ?? ""}`;
      if (!declaration.base || !existsSync(baseAbsolute))
        fail(`missing declared baseline: ${capture.identity}`);
      const baseActual = createHash("sha256").update(readFileSync(baseAbsolute)).digest("hex");
      if (baseActual !== capture.comparison.baseSha256)
        fail(`declared baseline bytes changed: ${capture.identity}`);
      if (
        !capture.comparison.referenceSha256 ||
        !/^[0-9a-f]{64}$/i.test(capture.comparison.referenceSha256)
      )
        fail(`capture reference bytes unbound: ${capture.identity}`);
      const referenceAbsolute = `${options.artifactRoot}/${declaration.reference ?? ""}`;
      if (!declaration.reference || !existsSync(referenceAbsolute))
        fail(`missing declared reference: ${capture.identity}`);
      const referenceActual = createHash("sha256")
        .update(readFileSync(referenceAbsolute))
        .digest("hex");
      if (referenceActual !== capture.comparison.referenceSha256)
        fail(`declared reference bytes changed: ${capture.identity}`);
      if (!capture.artifacts.referenceDiff)
        fail(`reference comparison diff not inventoried: ${capture.identity}`);
    }
    if (
      declaration.role === "base-guard" &&
      declaration.base &&
      capture.comparison.outcome === "control"
    )
      fail(`base-guard with a declared base must compare: ${capture.identity}`);
  }
  const expectedCaseIds = selection.cases.map(caseIdentity);
  if (actual.size !== expectedCaseIds.length || expectedCaseIds.some((id) => !actual.has(id)))
    fail("run manifest capture inventory differs from declaration");
  const actualGuards = new Set<string>();
  for (const guard of manifest.guardCaptures) {
    const id = guardIdentity(guard);
    if (actualGuards.has(id)) fail(`duplicate guard capture identity: ${id}`);
    actualGuards.add(id);
    const declaration = selection.guards.find((candidate) => guardIdentity(candidate) === id);
    if (!declaration || guard.route !== declaration.route || guard.width !== declaration.width)
      fail(`guard capture differs from declaration: ${id}`);
    if (
      guard.crop.x !== 0 ||
      guard.crop.y !== 0 ||
      guard.crop.width !== declaration.width ||
      guard.crop.height !== 850
    )
      fail(`guard crop differs from declaration: ${id}`);
    for (const [key, artifact] of Object.entries(guard.artifacts)) {
      if (key === "controls") {
        for (const [index, control] of (artifact as readonly ArtifactRecord[]).entries())
          checkArtifact(control as ArtifactRecord, `${id}.controls[${index}]`);
      } else checkArtifact(artifact as ArtifactRecord, `${id}.${key}`);
    }
    if (!Number.isFinite(guard.elapsedMs) || guard.elapsedMs < 0)
      fail(`invalid elapsed time for ${id}`);
    if (guard.readiness.length === 0 || guard.populatedWidgets.length === 0)
      fail(`guard evidence is incomplete for ${id}`);
  }
  if (actualGuards.size !== expectedGuards.length)
    fail("run manifest guard capture inventory differs from declaration");
}
