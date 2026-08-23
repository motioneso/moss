import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Lane, Settings } from "./types.js";

const CLI = path.resolve(import.meta.dirname, "..", "..", "fleetctl.mjs");
const SERVICE_NAME = "jarv1s-fleet-tick";

function systemdQuote(value: string): string {
  return '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';
}

function atomicWrite(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, contents);
  fs.renameSync(temp, file);
}

export function serviceFiles(
  dir: string,
  configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
) {
  const systemdDir = path.join(configHome, "systemd", "user");
  const tick = path.resolve(import.meta.dirname, "..", "..", "tick.sh");
  return {
    service: path.join(systemdDir, SERVICE_NAME + ".service"),
    timer: path.join(systemdDir, SERVICE_NAME + ".timer"),
    serviceText:
      "[Unit]\nDescription=Jarv1s fleet daemon tick\n\n[Service]\nType=oneshot\nTimeoutStartSec=10min\nEnvironment=JARV1S_FLEET_STATE=" +
      systemdQuote(dir) +
      "\nExecStart=" +
      systemdQuote(tick) +
      "\nStandardOutput=journal\nStandardError=journal\nSyslogIdentifier=" +
      SERVICE_NAME +
      "\n",
    timerText:
      "[Unit]\nDescription=Run the Jarv1s fleet daemon tick every minute\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=1min\nAccuracySec=15s\n\n[Install]\nWantedBy=timers.target\n"
  };
}

export function installUserService(dir: string, configHome?: string): void {
  const files = serviceFiles(dir, configHome);
  atomicWrite(files.service, files.serviceText);
  atomicWrite(files.timer, files.timerText);
  execFileSync("systemctl", ["--user", "daemon-reload"]);
}

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

export function startDaemon(dir: string): void {
  installUserService(dir);
  execFileSync("systemctl", ["--user", "enable", "--now", SERVICE_NAME + ".timer"]);
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
    const command = String(settings.judgeCmd) + ' "$FLEET_JUDGE_PROMPT"';
    const child = spawn("/bin/sh", ["-c", command, "--"], {
      env: { ...process.env, FLEET_JUDGE_PROMPT: prompt },
      stdio: ["ignore", "pipe", "pipe"]
    });
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
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else if (code === 0) reject(new Error("judgment command returned no answer"));
      else
        reject(
          new Error(stderr.trim() || "judgment command exited with " + String(code ?? "an error"))
        );
    });
  });
}

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function spawnRescueAgent(lane: Lane, settings: Settings, reading: string): void {
  const name = "fleet-rescue-" + lane.issue + "-" + Date.now();
  const worktree = lane.worktree || process.cwd();
  const fleetctlPath = path.resolve(worktree, "scripts/fleet/fleetctl.mjs");
  const claim =
    "node " +
    shellQuote(fleetctlPath) +
    " set " +
    lane.issue +
    " status=building agent=" +
    name +
    " paused=false pausedAt=null pausedBy=null && node " +
    shellQuote(fleetctlPath) +
    " log " +
    lane.issue +
    " " +
    shellQuote("spawn: rescue agent " + name);
  const model = settings.buildModels[lane.tier || "routine"];
  if (!model?.model || !model.effort)
    throw new Error("No build model and effort are configured for this lane.");
  const panes = JSON.parse(execFileSync("herdr", ["pane", "list"], { encoding: "utf8" }));
  const basePane = panes?.result?.panes?.[0]?.pane_id;
  if (!basePane) throw new Error("no Herdr pane is available");
  const split = JSON.parse(
    execFileSync(
      "herdr",
      ["pane", "split", basePane, "--direction", "down", "--cwd", worktree, "--no-focus"],
      { encoding: "utf8" }
    )
  );
  const pane = split?.result?.pane_id ?? split?.result?.pane?.pane_id;
  if (!pane) throw new Error("Herdr could not create a rescue pane");
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
      "--model",
      model.model,
      "--effort",
      model.effort,
      "--permission-mode",
      "bypassPermissions",
      "You are rescuing issue #" +
        lane.issue +
        ". Your first action must be to run " +
        claim +
        ". Then continue under the normal fleet rules. The judgment call was:\n" +
        reading +
        "\nDo not touch production, delete data, rewrite history, disable checks, or merge unproven work."
    ],
    { stdio: "ignore" }
  );
}

export function acceptRescue(dir: string, lane: Lane, reading: string): void {
  logLane(dir, lane.issue, "human accepted the rescue preview");
  const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8")) as Settings;
  spawnRescueAgent(lane, settings, reading);
}
