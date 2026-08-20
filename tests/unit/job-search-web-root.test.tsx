// Task 18 (#1302): Root itself, in the plain node environment (no jsdom — Root needs no real
// document; see tests/unit/job-search-use-profiles.test.tsx's header for why THAT file needs
// jsdom and this one doesn't). use-profiles.ts, api.ts, latch.ts, and styles.css are all mocked
// so this file exercises only Root's own logic: the bootstrap handoff, the empty/onboarding/
// board branch, the enqueue latch's call sites (not its storage — that's latch.ts's own
// concern, mocked here), and queue-outcome rendering.
//
// Test 11 (assistant-surface binding) belongs to Task 17, not this file.
import "./helpers/install-module-runtime";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseProfiles } = vi.hoisted(() => ({ mockUseProfiles: vi.fn() }));
vi.mock("../../external-modules/job-search/src/web/use-profiles", () => ({
  useProfiles: mockUseProfiles
}));

vi.mock("../../external-modules/job-search/src/web/api", () => ({
  invokeTool: vi.fn(),
  runQueue: vi.fn()
}));

// A module-scope Set standing in for latch.ts's real localStorage-backed storage — real
// storage would silently no-op in this node environment (no `window`), which would make
// tests 6-9 unable to observe latching at all. See latch.ts's own header for why it was
// split out of root.tsx in the first place.
const { latchStore } = vi.hoisted(() => ({ latchStore: new Set<string>() }));
vi.mock("../../external-modules/job-search/src/web/latch", () => ({
  isLatched: (actorScopeKey: string, profileId: string) =>
    latchStore.has(`${actorScopeKey}:${profileId}`),
  setLatched: (actorScopeKey: string, profileId: string) => {
    latchStore.add(`${actorScopeKey}:${profileId}`);
  }
}));

vi.mock("../../external-modules/job-search/src/web/styles.css", () => ({ default: "" }));

/** What `job-search.resume.get` hands back. Reset to null before every test (the empty-profile
 *  default); a test that wants the first crawl to fire sets it to RESUME_ON_FILE first. */
let resumeFixture: { version: number; content: string; updatedAt: string } | null = null;

/** Whether `job-search.matches.list` answers with an empty board. Root's crawl effect is a
 *  bootstrap and only fires when the board has nothing on it (see the effect's comment in
 *  root.tsx), so every test that asserts an enqueue sets this true; the default false keeps the
 *  one-row fixture below that the board-rendering assertions read. */
let boardEmpty = false;
const RESUME_ON_FILE = {
  version: 1,
  content: "Staff engineer. TypeScript, Postgres, React.",
  updatedAt: "2026-07-29T10:35:44.701Z"
};
const CURRENT_CRITERIA = {
  titles: ["Staff Engineer"],
  seniority: [],
  locations: [],
  remote: "no-preference",
  compFloorCents: null,
  excludeCompanies: [],
  mustHave: [],
  niceToHave: [],
  dealbreakers: [],
  wantNarrative: ""
};

import { Root, type HostActions } from "../../external-modules/job-search/src/web/root";
import * as api from "../../external-modules/job-search/src/web/api";
import {
  seedIdempotencyKey,
  type AssistantSurfaceHandleV1
} from "../../external-modules/job-search/src/domain/seed-prompt";
import type {
  Profile,
  ProfilesState
} from "../../external-modules/job-search/src/web/use-profiles";

function profile(overrides: Partial<Profile> = {}): Profile {
  return {
    profileId: "p1",
    name: "Acme SWE search",
    state: "active",
    briefingDetail: null,
    completedSteps: ["role", "want", "where", "comp", "sources"],
    readyToCrawl: true,
    // Deliberately distinct from profileId — Task 17/#1301's thread binding uses this field,
    // not profileId, and a fixture where the two values happened to match would let a
    // regression back to profileId-based binding pass silently.
    surfaceKey: "surf-1",
    ...overrides
  };
}

function hostActions(overrides: Partial<HostActions> = {}): HostActions {
  return {
    actorScopeKey: "actor-1",
    openAssistant: vi.fn(),
    ...overrides
  };
}

type MockedProfilesState = ProfilesState & { refetch(): void; select(id: string): void };

function ready(
  profiles: Profile[],
  selectedId = profiles[0]?.profileId ?? ""
): MockedProfilesState {
  return { status: "ready", profiles, selectedId, refetch: vi.fn(), select: vi.fn() };
}

function empty(): MockedProfilesState {
  return { status: "empty", refetch: vi.fn(), select: vi.fn() };
}

async function renderRoot(
  actions: HostActions = hostActions(),
  assistantSurface?: AssistantSurfaceHandleV1
): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(Root, { hostActions: actions, assistantSurface }));
  });
  return renderer;
}

interface TestAssistantRecordV1 {
  readonly kind: string;
  readonly text: string;
  readonly actionRequestId?: string;
  readonly toolName?: string;
  readonly outcome?: "executed" | "denied" | "error" | "allowed";
  readonly result?: Record<string, unknown>;
}

function deferredCriteriaRecord(actionRequestId: string): TestAssistantRecordV1 {
  return {
    kind: "action_result",
    text: "Search criteria updated",
    actionRequestId,
    toolName: "job-search.criteria.set",
    outcome: "executed",
    result: { profileId: "p1", rescore: { ok: true, attempted: false } }
  };
}

// Root binds, frames, and subscribes through this surface. The fixture keeps the live-record
// boundary faithful to the host: subscribers receive cumulative arrays, and unsubscription stops
// later emissions without exposing any of the host's internal store.
function assistantSurface() {
  let listener: ((records: readonly TestAssistantRecordV1[]) => void) | undefined;
  return {
    setSurfaceKey: vi.fn(),
    seedContext: vi.fn().mockResolvedValue(undefined),
    seedComposer: vi.fn(),
    Surface: vi.fn(),
    submitTurn: vi.fn().mockResolvedValue(undefined),
    subscribeRecords: vi.fn((next: (records: readonly TestAssistantRecordV1[]) => void) => {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    }),
    emitRecords(records: readonly TestAssistantRecordV1[]) {
      listener?.(records);
    }
  };
}

// Flushes the microtask queue a few times over — enough for a mocked
// runQueue's resolved promise to reach its .then(setQueueNotice).
async function flush(renderer: ReactTestRenderer): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  void renderer;
}

function text(renderer: ReactTestRenderer): string {
  // Adjacent JSX text expressions (e.g. QueueNotice's "Couldn't queue a search
  // run: {outcome.message}") render as separate string children that
  // flatten() joins with a space — collapse runs of whitespace so assertions
  // don't have to guess the exact split.
  return flatten(renderer.toJSON()).replace(/\s+/g, " ").trim();
}

function flatten(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(flatten).join(" ");
  if (typeof node === "object" && "children" in (node as { children?: unknown })) {
    return flatten((node as { children?: unknown }).children);
  }
  return "";
}

function findButton(renderer: ReactTestRenderer, name: RegExp) {
  return renderer.root.findAllByType("button").find((item) => {
    const children = Array.isArray(item.props.children)
      ? item.props.children
      : [item.props.children];
    return children.some((child: unknown) => typeof child === "string" && name.test(child));
  });
}

function findParagraphsByRole(renderer: ReactTestRenderer, role: string) {
  return renderer.root.findAllByType("p").filter((item) => item.props.role === role);
}

describe("job-search web Root", () => {
  beforeEach(() => {
    mockUseProfiles.mockReset();
    resumeFixture = null;
    boardEmpty = false;
    vi.mocked(api.invokeTool).mockReset();
    // Default transport for the real BoardScreen/SettingsScreen now rendered once a profile is
    // "active" (Task 20 replaced BoardPlaceholder) — a non-empty matches.list result is what
    // makes this file's "renders the real board" assertions still true (checked by matching on
    // the match's title text, not a <table> element — K2's keyline restructure replaced board.tsx's
    // table with a .jsm-list of rule-separated rows); individual tests don't otherwise care what
    // the board or settings screens render.
    //
    // Shape matches the real BoardMatch (board-types.ts / worker/handlers/matches.ts) as of N39:
    // no fitReason/wantReason on the list row (those moved to MatchDetail, fetched separately by
    // job-search.match.get), and url is required — found missing here by #1335's follow-up audit,
    // since board.tsx:219-223 casts this response with no runtime validation, so a stale fixture
    // shape here would have kept passing silently. location/source/postedAt added by K5 — K2's
    // match-row.tsx (unmocked here; the real BoardScreen renders through it) calls
    // formatPostedOn(item.postedAt) unconditionally, and formatPostedOn only guards against
    // `null`, not `undefined`, so an omitted field crashed every test in this file that reaches
    // the Matches tab the moment K2's row extraction landed — the same #1335 trap (.tsx fixtures
    // aren't typechecked) catching a second field.
    vi.mocked(api.invokeTool).mockImplementation(async (name: string) => {
      if (name === "job-search.matches.list") {
        if (boardEmpty) return { items: [] };
        return {
          items: [
            {
              id: "m1",
              title: "Senior Engineer",
              company: "Acme",
              fit: 80,
              want: 70,
              outsideFrame: false,
              state: "new",
              url: "https://example.com/jobs/m1",
              location: "Remote — US",
              source: "LinkedIn",
              postedAt: "2026-07-15T09:00:00.000Z"
            }
          ]
        };
      }
      if (name === "job-search.portal.list") return { portals: [] };
      // K5: the Overview and Profile tabs (screens/overview.tsx, screens/profile.tsx) each make
      // their own resume.get read the moment they mount — every K5 test below visits at least one
      // of those tabs, so this needs a real answer rather than falling through to the catch-all
      // throw below (that would still render, since both screens swallow a rejected fetch into an
      // "error" state, but a passing suite that only exercises the error branch would be worthless
      // as K5 coverage).
      // Root's crawl effect now reads this too, and gates the first crawl.run on it — see the
      // effect's own comment in root.tsx for why (all module queues share one serialized lane, so
      // a pre-résumé crawl locks out the résumé save for its full ceiling). Tests that assert an
      // enqueue therefore have to put a résumé on file first; `resumeFixture` is how.
      if (name === "job-search.resume.get") return { resume: resumeFixture };
      if (name === "job-search.profile.get") {
        return {
          criteria: CURRENT_CRITERIA,
          contextSummary: null
        };
      }
      throw new Error(`unexpected invokeTool ${name}`);
    });
    vi.mocked(api.runQueue).mockReset();
    vi.mocked(api.runQueue).mockResolvedValue({ kind: "queued" });
    latchStore.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("starts bootstrap immediately with zero profiles", async () => {
    mockUseProfiles.mockReturnValue(empty());
    const renderer = await renderRoot();

    expect(text(renderer)).toMatch(/Setting up your job search profile/);
    expect(api.runQueue).toHaveBeenCalledWith("job-search.profile-bootstrap", "profile.bootstrap");
    expect(renderer.root.findAllByType("table")).toHaveLength(0);
  });

  // The bootstrap writes its own first record through the module's queue. It must not invoke a
  // write tool directly (the browser REST path 403s those), and it must not depend on the model
  // choosing to call one — on a live instance that dead-ended the module's very first click:
  // the assistant opened an interview, no row was ever written, and this panel polled forever.
  it("bootstrap enqueues profile.bootstrap and never invokes a tool directly", async () => {
    mockUseProfiles.mockReturnValue(empty());
    vi.mocked(api.runQueue).mockResolvedValue({ kind: "queued" });
    const actions = hostActions();
    const renderer = await renderRoot(actions);

    expect(api.runQueue).toHaveBeenCalledTimes(1);
    expect(api.runQueue).toHaveBeenCalledWith("job-search.profile-bootstrap", "profile.bootstrap");
    expect(api.invokeTool).not.toHaveBeenCalled();
    // The user is never made to say anything to bootstrap the module.
    expect(actions.openAssistant).not.toHaveBeenCalled();

    // Root re-renders with pollArmed flipped true — Root's own arming signal,
    // not the hook's (mocked) internal timing.
    const lastCallProps = mockUseProfiles.mock.calls.at(-1)![0];
    expect(lastCallProps.pollArmed).toBe(true);
    expect(text(renderer)).toMatch(/Setting up your job search profile/);
  });

  // A queue turned off for the account can never produce a profile, so waiting is the wrong
  // answer: say so and offer the retry rather than spinning on "Setting up…" indefinitely.
  it("stops waiting and surfaces the notice when the bootstrap queue is disabled", async () => {
    mockUseProfiles.mockReturnValue(empty());
    vi.mocked(api.runQueue).mockResolvedValue({ kind: "disabled" });
    const renderer = await renderRoot();

    await flush(renderer);

    expect(mockUseProfiles.mock.calls.at(-1)![0].pollArmed).toBe(false);
    expect(text(renderer)).toMatch(/turned off for this account/);
    expect(findButton(renderer, /Try again/i)).toBeTruthy();
  });

  // "Try again" is the panel's only escape from a failed bootstrap. Re-arming the poll without
  // re-running the queue would just wait harder against the same empty table.
  it("re-runs the bootstrap queue on retry", async () => {
    mockUseProfiles.mockReturnValue(empty());
    vi.mocked(api.runQueue).mockResolvedValue({ kind: "error", message: "boom" });
    const renderer = await renderRoot();

    await flush(renderer);
    await act(async () => {
      findButton(renderer, /Try again/i)!.props.onClick();
    });

    expect(api.runQueue).toHaveBeenCalledTimes(2);
  });

  it("renders the real onboarding screen for a profile with no criteria yet", async () => {
    mockUseProfiles.mockReturnValue(ready([profile({ state: "in_conversation" })]));
    const renderer = await renderRoot();

    expect(text(renderer)).toMatch(/work out what this search is for/);
    expect(renderer.root.findAllByType("table")).toHaveLength(0);
  });

  // #1331: OnboardingScreen's own test file (job-search-web-onboarding.test.tsx) proves the
  // screen renders Surface when handed one directly — that alone doesn't prove Root ever hands
  // it one for real. This asserts through root.tsx's prop threading itself, not just the prop.
  it("threads the host's assistantSurface through to the real onboarding screen", async () => {
    function SurfaceSpy() {
      return createElement("div", { "data-testid": "job-search-onboarding-surface" });
    }
    mockUseProfiles.mockReturnValue(
      ready([profile({ profileId: "p1", state: "in_conversation" })])
    );
    const surface: AssistantSurfaceHandleV1 = {
      setSurfaceKey: vi.fn(),
      seedContext: vi.fn().mockResolvedValue(undefined),
      seedComposer: vi.fn(),
      Surface: SurfaceSpy,
      submitTurn: vi.fn().mockResolvedValue(undefined),
      subscribeRecords: vi.fn(() => () => undefined)
    };

    const renderer = await renderRoot(hostActions(), surface);

    expect(renderer.root.findAllByType(SurfaceSpy)).toHaveLength(1);
    expect(surface.setSurfaceKey).toHaveBeenCalledWith("surf-1");
    expect(surface.seedContext).not.toHaveBeenCalled();
  });

  it("renders the real board screen for a profile with criteria", async () => {
    mockUseProfiles.mockReturnValue(ready([profile({ state: "active" })]));
    const renderer = await renderRoot();
    await flush(renderer);

    // K2's keyline restructure replaced board.tsx's <table> with a rule-separated .jsm-list —
    // check for the real match's title text instead of a table element.
    expect(text(renderer)).toMatch(/Senior Engineer/);
    expect(text(renderer)).not.toMatch(/work out what this search is for/);
  });

  it("keeps the completed onboarding conversation visible until the user opens matches", async () => {
    const actions = hostActions();
    mockUseProfiles.mockReturnValue(ready([profile({ state: "in_conversation" })]));
    const renderer = await renderRoot(actions);

    mockUseProfiles.mockReturnValue(ready([profile({ state: "active" })]));
    await act(async () => {
      renderer.update(createElement(Root, { hostActions: actions }));
    });

    expect(text(renderer)).toMatch(/work out what this search is for/);
    expect(text(renderer)).not.toMatch(/Senior Engineer/);

    await act(async () => {
      findButton(renderer, /View matches/i)!.props.onClick();
    });
    await flush(renderer);

    expect(text(renderer)).toMatch(/Senior Engineer/);
    expect(text(renderer)).not.toMatch(/work out what this search is for/);
  });

  it("never renders a chat button anywhere on the surface", async () => {
    mockUseProfiles.mockReturnValue(ready([profile({ state: "active" })]));
    const renderer = await renderRoot();
    await flush(renderer);

    expect(findButton(renderer, /chat/i)).toBeUndefined();
  });

  it("enqueues exactly one crawl.run for a profile that arrives active, and stays at one across a re-render", async () => {
    resumeFixture = RESUME_ON_FILE; // the crawl is gated on one being on file
    boardEmpty = true; // ...and on the board having nothing to show yet
    mockUseProfiles.mockReturnValue(ready([profile({ profileId: "p1", state: "active" })]));
    const actions = hostActions({ actorScopeKey: "actor-1" });
    const renderer = await renderRoot(actions);
    await flush(renderer);

    expect(api.runQueue).toHaveBeenCalledTimes(1);
    expect(api.runQueue).toHaveBeenCalledWith("job-search.crawl-run", "crawl.run", {
      profileId: "p1"
    });

    // A subsequent refetch/re-render with the same (now-latched) profile must
    // not enqueue a second time.
    await act(async () => {
      renderer.update(createElement(Root, { hostActions: actions }));
    });
    await flush(renderer);
    expect(api.runQueue).toHaveBeenCalledTimes(1);
  });

  // Every queue this module declares shares ONE serialized invocation lane per module in the host
  // runtime, so a crawl.run holds that lane for its whole 600s ceiling. Measured live before this
  // gate existed: the mount crawl held the lane 9m58s and the résumé save enqueued 12s behind it
  // never ran at all — it expired on its own ceiling as `handler_failed`, which the user saw as a
  // save that spun forever. Crawling before a résumé exists is wasted work regardless (score.ts
  // leaves fit null with no résumé text), so the ordering is résumé first, then crawl.
  it("does not enqueue the first crawl until a résumé is on file, and does not burn the latch", async () => {
    resumeFixture = null;
    boardEmpty = true; // isolates the résumé gate — the board gate is already satisfied
    mockUseProfiles.mockReturnValue(ready([profile({ profileId: "p1", state: "active" })]));
    const actions = hostActions({ actorScopeKey: "actor-1" });
    const renderer = await renderRoot(actions);
    await flush(renderer);
    expect(api.runQueue).not.toHaveBeenCalled();

    // Not latching on the no-résumé path is the half that matters: latch here and this browser
    // would never crawl this profile at all, however many résumés were added afterwards.
    resumeFixture = RESUME_ON_FILE;
    // A fresh state object, because that is what the effect's deps actually watch — the real
    // trigger is ProfileScreen's onResumeSaved, which both refetches profiles and bumps Root's
    // resumeSavedTick for exactly the case where the refetch returns an equal object.
    mockUseProfiles.mockReturnValue(ready([profile({ profileId: "p1", state: "active" })]));
    await act(async () => {
      renderer.update(createElement(Root, { hostActions: actions }));
    });
    await flush(renderer);
    expect(api.runQueue).toHaveBeenCalledWith("job-search.crawl-run", "crawl.run", {
      profileId: "p1"
    });
  });

  // The other half of the same lane problem, and the one that bites after the first run. Once a
  // résumé is on file the résumé gate above passes on every mount, so replacing a résumé used to
  // fire a mount crawl that took the module's only queue lane and starved the save behind it —
  // measured live at 17:46: crawl.run active, resume-set enqueued 11s later and still not started
  // two minutes on, with the résumé row untouched. A board that already has rows has nothing to
  // bootstrap: crawl-sweep keeps it fresh and "Search now" covers an explicit refresh.
  it("does not enqueue a mount crawl when the board already has rows", async () => {
    resumeFixture = RESUME_ON_FILE;
    boardEmpty = false; // the default one-row fixture — a board with something already on it
    mockUseProfiles.mockReturnValue(ready([profile({ profileId: "p1", state: "active" })]));
    const renderer = await renderRoot(hostActions({ actorScopeKey: "actor-1" }));
    await flush(renderer);
    expect(api.runQueue).not.toHaveBeenCalled();
  });

  it("the enqueue latch survives an unmount/remount for the same actor", async () => {
    resumeFixture = RESUME_ON_FILE; // the crawl is gated on one being on file
    boardEmpty = true; // ...and on the board having nothing to show yet
    const actions = hostActions({ actorScopeKey: "actor-A" });
    mockUseProfiles.mockReturnValue(ready([profile({ profileId: "p1", state: "active" })]));

    const first = await renderRoot(actions);
    await flush(first);
    expect(api.runQueue).toHaveBeenCalledTimes(1);
    first.unmount();

    const second = await renderRoot(actions);
    await flush(second);
    expect(api.runQueue).toHaveBeenCalledTimes(1);
  });

  it("does not carry a latch across different actorScopeKeys", async () => {
    resumeFixture = RESUME_ON_FILE; // the crawl is gated on one being on file
    boardEmpty = true; // ...and on the board having nothing to show yet
    mockUseProfiles.mockReturnValue(ready([profile({ profileId: "p1", state: "active" })]));

    const first = await renderRoot(hostActions({ actorScopeKey: "actor-A" }));
    await flush(first);
    expect(api.runQueue).toHaveBeenCalledTimes(1);

    const second = await renderRoot(hostActions({ actorScopeKey: "actor-B" }));
    await flush(second);
    expect(api.runQueue).toHaveBeenCalledTimes(2);
    expect(api.runQueue).toHaveBeenLastCalledWith("job-search.crawl-run", "crawl.run", {
      profileId: "p1"
    });
  });

  it("enqueues nothing for a profile still in_conversation", async () => {
    mockUseProfiles.mockReturnValue(ready([profile({ state: "in_conversation" })]));
    const renderer = await renderRoot();
    await flush(renderer);

    expect(api.runQueue).not.toHaveBeenCalled();
  });

  it("renders a calm queued notice for already-queued, and an explicit notice for disabled", async () => {
    resumeFixture = RESUME_ON_FILE; // the crawl is gated on one being on file
    boardEmpty = true; // ...and on the board having nothing to show yet
    vi.mocked(api.runQueue).mockResolvedValueOnce({ kind: "already-queued" });
    mockUseProfiles.mockReturnValue(ready([profile({ profileId: "p1", state: "active" })]));
    const renderer = await renderRoot(hostActions({ actorScopeKey: "actor-queued" }));
    await flush(renderer);

    const status = findParagraphsByRole(renderer, "status");
    // The copy says what the user is waiting for and where it will appear, rather than naming the
    // internal event ("a search run has been queued") — a queue is our word, not theirs.
    expect(status.some((p) => flatten(p.props.children).match(/Searching for new roles/))).toBe(
      true
    );
    expect(findParagraphsByRole(renderer, "alert")).toHaveLength(0);

    vi.mocked(api.runQueue).mockResolvedValueOnce({ kind: "disabled" });
    mockUseProfiles.mockReturnValue(ready([profile({ profileId: "p2", state: "active" })]));
    const renderer2 = await renderRoot(hostActions({ actorScopeKey: "actor-disabled" }));
    await flush(renderer2);

    expect(text(renderer2)).toMatch(/Manual search runs are turned off for this account/);
  });

  // Test 11 (Task 17, #1301): assistant-surface binding.
  it("binds the surface before framing it, and frames it only once across a re-render", async () => {
    // surfaceKey deliberately differs from profileId here (Task 17/#1301's own constraint): the
    // thread binding below must key off surfaceKey, and the idempotency key must still key off
    // profileId — a fixture where the two matched couldn't catch a regression back to
    // profileId-based binding.
    mockUseProfiles.mockReturnValue(
      ready([profile({ profileId: "p1", surfaceKey: "surf-p1", state: "active" })])
    );
    const surface = assistantSurface();
    const actions = hostActions();
    const renderer = await renderRoot(actions, surface);
    await flush(renderer);

    expect(surface.setSurfaceKey).toHaveBeenCalledWith("surf-p1");
    expect(surface.seedContext).toHaveBeenCalledTimes(1);
    const [seedText, idempotencyKey] = vi.mocked(surface.seedContext).mock.calls[0];
    // Derived, not literal: the key carries a version suffix that is bumped every time the
    // seed text changes, and a hardcoded "v1" here silently rotted this suite red for three
    // bumps before anyone ran it. What matters is that the key is the one the module mints.
    expect(idempotencyKey).toBe(seedIdempotencyKey("p1"));
    expect(seedText).toContain("job-search.criteria.set");

    // Ordering, not just presence: seeding before binding frames the drawer instead of this
    // module's own thread (H4 — the consent boundary).
    const setSurfaceKeyOrder = vi.mocked(surface.setSurfaceKey).mock.invocationCallOrder[0];
    const seedContextOrder = vi.mocked(surface.seedContext).mock.invocationCallOrder[0];
    expect(setSurfaceKeyOrder).toBeLessThan(seedContextOrder);

    // A re-render with the same surface and the same profile must not re-seed.
    await act(async () => {
      renderer.update(createElement(Root, { hostActions: actions, assistantSurface: surface }));
    });
    await flush(renderer);
    expect(surface.seedContext).toHaveBeenCalledTimes(1);
  });

  it("continues a direct chat criteria save through the scoring queue exactly once", async () => {
    mockUseProfiles.mockReturnValue(
      ready([profile({ profileId: "p1", surfaceKey: "surf-p1", state: "active" })])
    );
    const surface = assistantSurface();
    const renderer = await renderRoot(hostActions(), surface);
    await flush(renderer);

    const record = deferredCriteriaRecord("action-criteria-1");

    await act(async () => {
      surface.emitRecords([record]);
    });
    await flush(renderer);

    expect(
      vi.mocked(api.invokeTool).mock.calls.filter(([name]) => name === "job-search.profile.get")
    ).toHaveLength(0);
    expect(api.runQueue).toHaveBeenCalledWith("job-search.crawl-sweep", "job-search.rescore-sweep");

    // The host publishes a cumulative transcript, so the same record appears in every later
    // snapshot. Replaying it must not enqueue a second scoring pass.
    await act(async () => {
      surface.emitRecords([record]);
    });
    await flush(renderer);
    expect(api.runQueue).toHaveBeenCalledTimes(1);

    // useProfileThread's binding effect is declared first. Since subscribeRecords is curried to
    // the currently bound surface, reversing this order would subscribe to the drawer instead.
    expect(vi.mocked(surface.setSurfaceKey).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(surface.subscribeRecords).mock.invocationCallOrder[0]
    );
  });

  it("ignores historical, foreign, failed, and already-scored criteria records", async () => {
    mockUseProfiles.mockReturnValue(ready([profile({ profileId: "p1", state: "active" })]));
    const surface = assistantSurface();
    const renderer = await renderRoot(hostActions(), surface);
    await flush(renderer);

    const deferredResult = {
      profileId: "p1",
      rescore: { ok: true, attempted: false }
    };
    await act(async () => {
      surface.emitRecords([
        // Historical transcript rows omit both live-only fields.
        {
          kind: "action_result",
          text: "Search criteria updated",
          toolName: "job-search.criteria.set",
          outcome: "executed"
        },
        {
          kind: "action_result",
          text: "Missing action id",
          toolName: "job-search.criteria.set",
          outcome: "executed",
          result: deferredResult
        },
        {
          kind: "action_result",
          text: "Different profile",
          actionRequestId: "action-wrong-profile",
          toolName: "job-search.criteria.set",
          outcome: "executed",
          result: { ...deferredResult, profileId: "p2" }
        },
        {
          kind: "action_result",
          text: "Different tool",
          actionRequestId: "action-wrong-tool",
          toolName: "job-search.resume.set",
          outcome: "executed",
          result: deferredResult
        },
        {
          kind: "action_result",
          text: "Tool failed",
          actionRequestId: "action-error",
          toolName: "job-search.criteria.set",
          outcome: "error",
          result: deferredResult
        },
        {
          kind: "action_result",
          text: "Already scored",
          actionRequestId: "action-already-scored",
          toolName: "job-search.criteria.set",
          outcome: "executed",
          result: { profileId: "p1", rescore: { ok: true, attempted: true } }
        },
        {
          kind: "tool",
          text: "Not an action result",
          actionRequestId: "action-wrong-kind",
          toolName: "job-search.criteria.set",
          outcome: "executed",
          result: deferredResult
        }
      ]);
    });
    await flush(renderer);

    expect(
      vi.mocked(api.invokeTool).mock.calls.filter(([name]) => name === "job-search.profile.get")
    ).toHaveLength(0);
    expect(api.runQueue).not.toHaveBeenCalled();
  });

  it.each([
    ["another payload is already queued", "already-queued"],
    ["the queue returns an error", "queue-error"]
  ] as const)("self-retries when %s without another records emission", async (_label, mode) => {
    mockUseProfiles.mockReturnValue(ready([profile({ profileId: "p1", state: "active" })]));
    const surface = assistantSurface();
    const renderer = await renderRoot(hostActions(), surface);
    await flush(renderer);
    vi.useFakeTimers();

    if (mode === "already-queued") {
      vi.mocked(api.runQueue).mockResolvedValueOnce({ kind: "already-queued" });
    } else if (mode === "queue-error") {
      vi.mocked(api.runQueue).mockResolvedValueOnce({
        kind: "error",
        message: "queue unavailable"
      });
    }

    await act(async () => {
      surface.emitRecords([deferredCriteriaRecord(`action-${mode}`)]);
    });
    await flush(renderer);
    if (mode === "queue-error") expect(text(renderer)).toContain("queue unavailable");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    await flush(renderer);
    expect(api.runQueue).toHaveBeenCalledTimes(2);
    expect(api.runQueue).toHaveBeenLastCalledWith(
      "job-search.crawl-sweep",
      "job-search.rescore-sweep"
    );
  });

  it("caps continuation attempts and cancels a pending retry on profile switch", async () => {
    mockUseProfiles.mockReturnValue(ready([profile({ profileId: "p1", state: "active" })]));
    vi.mocked(api.runQueue).mockResolvedValue({ kind: "already-queued" });
    const surface = assistantSurface();
    const actions = hostActions();
    const renderer = await renderRoot(actions, surface);
    await flush(renderer);
    vi.useFakeTimers();

    await act(async () => surface.emitRecords([deferredCriteriaRecord("action-capped")]));
    await flush(renderer);
    await act(async () => void (await vi.advanceTimersByTimeAsync(18_000)));
    expect(api.runQueue).toHaveBeenCalledTimes(3);
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(api.runQueue).toHaveBeenCalledTimes(3);

    await act(async () => surface.emitRecords([deferredCriteriaRecord("action-cleanup")]));
    await flush(renderer);
    expect(api.runQueue).toHaveBeenCalledTimes(4);
    mockUseProfiles.mockReturnValue(
      ready([profile({ profileId: "p2", surfaceKey: "surf-p2", state: "active" })])
    );
    await act(async () =>
      renderer.update(createElement(Root, { hostActions: actions, assistantSurface: surface }))
    );
    await act(async () => void (await vi.advanceTimersByTimeAsync(6_000)));
    expect(api.runQueue).toHaveBeenCalledTimes(4);
  });
  // Ruling N46: the surface key is what the drawer's own backfill path (packages/chat's
  // repository lookup) uses to pick the persisted thread — rotating surfaceKey while the
  // profile row stays put is exactly what lets a profile start a fresh conversation without
  // deleting the profile. A test that only checked "some key was set" would pass identically
  // whether the binding used surfaceKey or profileId, since this file's other fixtures give both
  // fields a value; this one is written specifically to fail if the binding ever goes back to
  // profileId; profileId itself never moves.
  it("rebinds to a new surface when surfaceKey changes while profileId stays the same", async () => {
    mockUseProfiles.mockReturnValue(
      ready([profile({ profileId: "p1", surfaceKey: "surf-a", state: "active" })])
    );
    const surface = assistantSurface();
    const actions = hostActions();
    const renderer = await renderRoot(actions, surface);
    await flush(renderer);

    expect(surface.setSurfaceKey).toHaveBeenLastCalledWith("surf-a");

    // Same profileId, rotated surfaceKey — simulates the profile's thread identity being reset
    // independently of the row, the capability the plan required and the deviation removed.
    mockUseProfiles.mockReturnValue(
      ready([profile({ profileId: "p1", surfaceKey: "surf-b", state: "active" })])
    );
    await act(async () => {
      renderer.update(createElement(Root, { hostActions: actions, assistantSurface: surface }));
    });
    await flush(renderer);

    // Binding followed surfaceKey to a genuinely different value. If this ever rebinds by
    // profileId instead, profileId is unchanged across the two renders and this call simply
    // never happens.
    expect(surface.setSurfaceKey).toHaveBeenLastCalledWith("surf-b");
    expect(surface.setSurfaceKey).toHaveBeenCalledWith("surf-a");

    // The seed re-fires (surfaceKey is a real effect dependency), but its idempotencyKey stays
    // pinned to profileId in both calls — the two axes documented in seed-prompt.ts stay
    // independent even as the surface rotates.
    expect(surface.seedContext).toHaveBeenCalledTimes(2);
    const [, firstIdempotencyKey] = vi.mocked(surface.seedContext).mock.calls[0];
    const [, secondIdempotencyKey] = vi.mocked(surface.seedContext).mock.calls[1];
    expect(firstIdempotencyKey).toBe(seedIdempotencyKey("p1"));
    expect(secondIdempotencyKey).toBe(seedIdempotencyKey("p1"));
  });

  it("renders fine when the host gives it no assistant surface", async () => {
    mockUseProfiles.mockReturnValue(ready([profile({ profileId: "p1", state: "active" })]));
    const renderer = await renderRoot(hostActions());
    await flush(renderer);

    // See the K2 keyline-restructure note above: board.tsx has no <table> anymore.
    expect(text(renderer)).toMatch(/Senior Engineer/);
  });

  // K5 (2026-07-28 keyline-restructure plan): the four-tab shell. These four tests are the plan's
  // own list for this task, in the plan's own order.
  describe("K5 four-tab shell", () => {
    it("renders all four tabs for an active profile, with Matches selected on mount", async () => {
      mockUseProfiles.mockReturnValue(ready([profile({ state: "active" })]));
      const renderer = await renderRoot();
      await flush(renderer);

      const matchesTab = findButton(renderer, /^Matches$/);
      const overviewTab = findButton(renderer, /^Overview$/);
      const profileTab = findButton(renderer, /^Profile$/);
      const monitorsTab = findButton(renderer, /^Monitors$/);
      expect(matchesTab).toBeTruthy();
      expect(overviewTab).toBeTruthy();
      expect(profileTab).toBeTruthy();
      expect(monitorsTab).toBeTruthy();

      expect(matchesTab!.props["aria-current"]).toBe("page");
      expect(overviewTab!.props["aria-current"]).toBeUndefined();
      expect(profileTab!.props["aria-current"]).toBeUndefined();
      expect(monitorsTab!.props["aria-current"]).toBeUndefined();
      expect(renderer.root.findAllByProps({ role: "tablist" })).toHaveLength(0);
      expect(renderer.root.findAllByProps({ role: "tab" })).toHaveLength(0);
      expect(renderer.root.findAllByType("h1").map((node) => flatten(node.children))).toEqual([
        "Job Search"
      ]);

      // Matches is the board — the pre-existing title-text assertion elsewhere in this file
      // already covers that it's the real BoardScreen, not a placeholder. (board.tsx has no
      // <table> — K2's keyline restructure draws a rule-separated .jsm-list instead.)
      expect(text(renderer)).toMatch(/Senior Engineer/);
    });

    it("selecting each tab renders that screen and unmounts the previous one", async () => {
      mockUseProfiles.mockReturnValue(ready([profile({ state: "active" })]));
      const renderer = await renderRoot();
      await flush(renderer);

      // Matches (default): the board's match content is present, no other screen's own copy is.
      expect(text(renderer)).toMatch(/Senior Engineer/);
      expect(text(renderer)).not.toMatch(/Search status/);
      expect(text(renderer)).not.toMatch(/knows about you/);
      expect(text(renderer)).not.toMatch(/Checks automatically/);

      await act(async () => {
        findButton(renderer, /^Overview$/)!.props.onClick();
      });
      await flush(renderer);
      // The board is gone — a real unmount, not a second screen layered on top.
      expect(text(renderer)).not.toMatch(/Senior Engineer/);
      expect(text(renderer)).toMatch(/Search status/);

      await act(async () => {
        findButton(renderer, /^Profile$/)!.props.onClick();
      });
      await flush(renderer);
      expect(text(renderer)).not.toMatch(/Search status/);
      expect(text(renderer)).toMatch(/Profile What it's looking for/);

      await act(async () => {
        findButton(renderer, /^Monitors$/)!.props.onClick();
      });
      await flush(renderer);
      expect(text(renderer)).not.toMatch(/What it's looking for/);
      expect(text(renderer)).toMatch(/Monitors Watched boards/);

      await act(async () => {
        findButton(renderer, /^Matches$/)!.props.onClick();
      });
      await flush(renderer);
      expect(text(renderer)).not.toMatch(/Monitors Watched boards/);
      expect(text(renderer)).toMatch(/Senior Engineer/);
    });

    it("Review unreviewed roles returns from Overview to Matches", async () => {
      mockUseProfiles.mockReturnValue(ready([profile({ state: "active" })]));
      const renderer = await renderRoot();
      await flush(renderer);

      await act(async () => {
        findButton(renderer, /^Overview$/)!.props.onClick();
      });
      await flush(renderer);
      await act(async () => {
        findButton(renderer, /^Review unreviewed roles$/)!.props.onClick();
      });
      await flush(renderer);

      expect(text(renderer)).toMatch(/Senior Engineer/);
    });

    it("switching profile preserves the selected tab; switching tab preserves the selected profile", async () => {
      const profiles = [
        profile({ profileId: "p1", name: "Search A", state: "active" }),
        profile({ profileId: "p2", name: "Search B", state: "active" })
      ];
      const actions = hostActions();
      mockUseProfiles.mockReturnValue(ready(profiles, "p1"));
      const renderer = await renderRoot(actions);
      await flush(renderer);

      // Move off the default tab first — if switching profile ever reset view state, staying on
      // "matches" (already the default) couldn't tell the difference.
      await act(async () => {
        findButton(renderer, /^Overview$/)!.props.onClick();
      });
      await flush(renderer);
      expect(findButton(renderer, /^Overview$/)!.props["aria-current"]).toBe("page");

      // Switch profile — same shape as this file's own surfaceKey-rebind test above: a real
      // profile switch happens via useProfiles handing Root a new selectedId, so simulate that by
      // re-rendering with an updated ready() fixture rather than clicking the mocked select().
      mockUseProfiles.mockReturnValue(ready(profiles, "p2"));
      await act(async () => {
        renderer.update(createElement(Root, { hostActions: actions }));
      });
      await flush(renderer);

      // The tab survived the profile switch — ActiveProfilePanel isn't remounted or reset by a
      // change in which profile is selected.
      expect(findButton(renderer, /^Overview$/)!.props["aria-current"]).toBe("page");

      // Now the reverse: switch tab again, then switch profile back, and confirm the profile
      // switcher (not the view switcher) is what changed — ProfileBar's own selected button.
      await act(async () => {
        findButton(renderer, /^Monitors$/)!.props.onClick();
      });
      await flush(renderer);
      mockUseProfiles.mockReturnValue(ready(profiles, "p1"));
      await act(async () => {
        renderer.update(createElement(Root, { hostActions: actions }));
      });
      await flush(renderer);

      expect(findButton(renderer, /^Monitors$/)!.props["aria-current"]).toBe("page");
      const searchA = findButton(renderer, /^Search A$/);
      expect(searchA!.props["aria-current"]).toBe("page");
    });

    it("renders onboarding and no tab bar for an in_conversation profile", async () => {
      mockUseProfiles.mockReturnValue(ready([profile({ state: "in_conversation" })]));
      const renderer = await renderRoot();

      expect(text(renderer)).toMatch(/work out what this search is for/);
      // None of the four view-tab labels exist anywhere — the tab bar itself isn't rendered, not
      // just hidden or disabled.
      expect(findButton(renderer, /^Matches$/)).toBeUndefined();
      expect(findButton(renderer, /^Overview$/)).toBeUndefined();
      expect(findButton(renderer, /^Profile$/)).toBeUndefined();
      expect(findButton(renderer, /^Monitors$/)).toBeUndefined();
      expect(renderer.root.findAllByType("h1").map((node) => flatten(node.children))).toEqual([
        "Job Search"
      ]);
      expect(text(renderer)).toMatch(/Setup incomplete/);
    });
  });

  it.each([
    ["active", true, "Monitoring on"],
    ["active", false, "Setup incomplete"],
    ["paused", true, "Paused"],
    ["in_conversation", false, "Setup incomplete"]
  ] as const)("shows an honest masthead for %s/%s", async (state, readyToCrawl, label) => {
    mockUseProfiles.mockReturnValue(ready([profile({ state, readyToCrawl })]));
    const renderer = await renderRoot();
    await flush(renderer);

    expect(text(renderer)).toContain("Moss · Module");
    expect(text(renderer)).toContain(label);
  });
});
