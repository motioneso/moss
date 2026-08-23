import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Lane, Settings } from "./types.js";

const CLI = path.resolve(import.meta.dirname, "..", "..", "fleetctl.mjs");

function fleetctl(dir: string, ...args: string[]): string {
  return execFileSync("node", [CLI, ...args], {
    env: { ...process.env, JARV1S_FLEET_STATE: dir },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

export function setLane(dir: string, issue: number, ...fields: string[]): void {
  fleetctl(dir, "set", String(issue), ...fields);
}

export function logLane(dir: string, issue: number, message: string): void {
  fleetctl(dir, "log", String(issue), message);
}

export function daemonActive(): boolean {
  try {
    execFileSync("systemctl", ["--user", "is-active", "--quiet", "jarv1s-fleet-tick.timer"]);
    return true;
  } catch {
    return false;
  }
}

export function startDaemon(): void {
  execFileSync("systemctl", ["--user", "start", "jarv1s-fleet-tick.timer"]);
}

export function messageAgent(agent: string | null | undefined, message: string): void {
  if (agent) execFileSync("herdr", ["agent", "prompt", agent, message], { stdio: "ignore" });
}

export async function askJudge(
  settings: Settings,
  prompt: string,
  timeoutMs = 30000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", settings.judgeCmd], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("judgment call timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `judgment command exited with ${code ?? "an error"}`));
    });
    child.stdin.end(prompt);
  });
}

function spawnRescueAgent(dir: string, lane: Lane, reading: string): void {
  const name = `fleet-rescue-${lane.issue}-${Date.now()}`;
  const briefDir = path.join(dir, "briefs");
  const brief = path.join(briefDir, `${name}.md`);
  fs.mkdirSync(briefDir, { recursive: true });
  fs.writeFileSync(
    brief,
    `You are rescuing issue #${lane.issue}. Claim the lane with fleetctl before touching anything.\n\n` +
      `The judgment call was:\n${reading}\n\n` +
      "Continue the issue under the normal fleet rules. Do not touch production, delete data, rewrite history, disable checks, or merge unproven work.\n"
  );
  const panes = JSON.parse(execFileSync("herdr", ["pane", "list"], { encoding: "utf8" }));
  const basePane = panes?.result?.panes?.[0]?.pane_id;
  if (!basePane) throw new Error("no Herdr pane is available");
  const split = JSON.parse(
    execFileSync(
      "herdr",
      [
        "pane",
        "split",
        basePane,
        "--direction",
        "down",
        "--cwd",
        lane.worktree || process.cwd(),
        "--no-focus"
      ],
      { encoding: "utf8" }
    )
  );
  const pane = split?.result?.pane_id ?? split?.result?.pane?.pane_id;
  if (!pane) throw new Error("Herdr could not create a rescue pane");
  setLane(
    dir,
    lane.issue,
    "status=building",
    `agent=${name}`,
    "paused=false",
    "pausedAt=null",
    "pausedBy=null"
  );
  execFileSync(
    "herdr",
    [
      "agent",
      "start",
      name,
      "--kind",
      "claude",
      "--pane",
      pane,
      "--",
      "--permission-mode",
      "bypassPermissions",
      `Read and follow ${brief} exactly.`
    ],
    { stdio: "ignore" }
  );
  logLane(dir, lane.issue, `spawn: rescue agent ${name}`);
}

export function acceptRescue(dir: string, lane: Lane, reading: string): void {
  spawnRescueAgent(dir, lane, reading);
}
