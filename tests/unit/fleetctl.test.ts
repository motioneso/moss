import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(__dirname, "../../scripts/fleet/fleetctl.mjs");

let stateDir: string;

function run(args: string[]): { stdout: string; code: number } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, JARV1S_FLEET_STATE: stateDir },
      encoding: "utf8"
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: e.stdout ?? "", code: e.status ?? -1 };
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "fleetctl-test-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("fleetctl", () => {
  it("round-trips a record through add and get", () => {
    const added = run(["add", "42", "spec=docs/specs/x.md", "tier=routine"]);
    expect(added.code).toBe(0);

    const got = run(["get", "42"]);
    expect(got.code).toBe(0);
    const record = JSON.parse(got.stdout);
    expect(record).toMatchObject({
      issue: 42,
      spec: "docs/specs/x.md",
      tier: "routine",
      status: "queued",
      pr: null,
      branch: null,
      worktree: null,
      agent: null,
      relays: 0,
      qa_rounds: 0,
      blocked_reason: null
    });
    expect(typeof record.updated_at).toBe("string");
  });

  it("exits 2 for get on a missing record", () => {
    expect(run(["get", "999"]).code).toBe(2);
  });

  it("sets fields and supports +1 increment syntax", () => {
    run(["add", "7", "spec=s.md", "tier=sensitive"]);
    const set = run(["set", "7", "status=pr-open", "pr=1234", "relays=+1", "qa_rounds=+1"]);
    expect(set.code).toBe(0);

    const record = JSON.parse(run(["get", "7"]).stdout);
    expect(record.status).toBe("pr-open");
    expect(record.pr).toBe(1234);
    expect(record.relays).toBe(1);
    expect(record.qa_rounds).toBe(1);

    run(["set", "7", "relays=+1"]);
    expect(JSON.parse(run(["get", "7"]).stdout).relays).toBe(2);
  });

  it("rejects a status outside the allowed vocabulary", () => {
    run(["add", "8", "spec=s.md", "tier=routine"]);
    expect(run(["set", "8", "status=finished"]).code).toBe(1);
    // record is unchanged
    expect(JSON.parse(run(["get", "8"]).stdout).status).toBe("queued");
  });

  it("rejects unknown fields", () => {
    run(["add", "9", "spec=s.md", "tier=routine"]);
    expect(run(["set", "9", "color=blue"]).code).toBe(1);
  });

  it("updates updated_at and logs a transition on every set", async () => {
    run(["add", "10", "spec=s.md", "tier=routine"]);
    const before = JSON.parse(run(["get", "10"]).stdout).updated_at as string;
    await new Promise((r) => setTimeout(r, 10));
    run(["set", "10", "status=building"]);
    const after = JSON.parse(run(["get", "10"]).stdout).updated_at as string;
    expect(after >= before).toBe(true);

    const logLines = readFileSync(join(stateDir, "log.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(logLines.some((l) => l.issue === 10 && l.msg.includes("status=building"))).toBe(true);
  });

  it("appends a log line with ts, issue and msg", () => {
    run(["add", "11", "spec=s.md", "tier=routine"]);
    expect(run(["log", "11", "hello", "world"]).code).toBe(0);
    const lines = readFileSync(join(stateDir, "log.jsonl"), "utf8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1] ?? "{}");
    expect(last.issue).toBe(11);
    expect(last.msg).toBe("hello world");
    expect(typeof last.ts).toBe("string");
  });

  it("lists one line per record", () => {
    run(["add", "3", "spec=a.md", "tier=routine"]);
    run(["add", "12", "spec=b.md", "tier=security"]);
    const { stdout, code } = run(["list"]);
    expect(code).toBe(0);
    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("3");
    expect(lines[1]).toContain("12");
    expect(lines[1]).toContain("security");
  });

  it("renders the board with the table, Needs Ben and Deputy rulings sections", () => {
    run(["add", "20", "spec=a.md", "tier=routine"]);
    run(["add", "21", "spec=b.md", "tier=security"]);
    run(["set", "21", "status=blocked", "blocked_reason=waiting on sign-off"]);
    run(["log", "20", "DEPUTY ruled: proceed with the smaller fix"]);

    expect(run(["board"]).code).toBe(0);
    const boardPath = join(stateDir, "board.md");
    expect(existsSync(boardPath)).toBe(true);
    const board = readFileSync(boardPath, "utf8");

    expect(board).toContain("# Fleet board");
    expect(board).toContain("#20");
    expect(board).toContain("#21");
    expect(board).toContain("## Needs Ben");
    expect(board).toContain("waiting on sign-off");
    expect(board).toContain("## Deputy rulings");
    expect(board).toContain("DEPUTY ruled: proceed with the smaller fix");
  });

  it("board shows empty-state text when nothing is blocked and no rulings exist", () => {
    run(["add", "30", "spec=a.md", "tier=routine"]);
    run(["board"]);
    const board = readFileSync(join(stateDir, "board.md"), "utf8");
    expect(board).toContain("Nothing right now.");
    expect(board).toContain("None.");
  });

  it("rejects add with a bad tier and duplicate add", () => {
    expect(run(["add", "40", "spec=a.md", "tier=urgent"]).code).toBe(1);
    expect(run(["add", "41", "spec=a.md", "tier=routine"]).code).toBe(0);
    expect(run(["add", "41", "spec=a.md", "tier=routine"]).code).toBe(1);
  });

  it("exits 2 with usage on an unknown command", () => {
    expect(run(["frobnicate"]).code).toBe(2);
  });
});
