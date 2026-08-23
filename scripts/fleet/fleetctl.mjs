#!/usr/bin/env node
// fleetctl — CLI for the fleet daemon's task records (issue #1893).
//
// State lives outside the repo (default ~/.local/state/jarv1s-fleet/, override with
// JARV1S_FLEET_STATE). One JSON file per lane under tasks/<issue>.json, an append-only
// log.jsonl, and a generated board.md that Ben reads in the morning.
//
// Exit codes: 0 ok, 1 validation error, 2 usage error or missing record.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STATUSES = [
  "queued",
  "building",
  "pr-open",
  "ci-red",
  "qa",
  "qa-red",
  "qa-green",
  "merging",
  "blocked",
  "done"
];

const TIERS = ["routine", "sensitive", "security"];

// Plain-English status labels for the board.
const STATUS_LABELS = {
  queued: "Waiting to start",
  building: "Being built",
  "pr-open": "PR open, waiting on checks",
  "ci-red": "Checks failing",
  qa: "In review",
  "qa-red": "Review found problems",
  "qa-green": "Review passed",
  merging: "Merging",
  blocked: "Needs Ben",
  done: "Done"
};

const INT_FIELDS = new Set(["pr", "relays", "qa_rounds"]);
const INCREMENT_FIELDS = new Set(["relays", "qa_rounds"]);
const SETTABLE_FIELDS = new Set([
  "spec",
  "tier",
  "status",
  "branch",
  "worktree",
  "pr",
  "agent",
  "relays",
  "qa_rounds",
  "blocked_reason"
]);

class CliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

const usageError = (msg) => new CliError(msg, 2);
const validationError = (msg) => new CliError(msg, 1);

function stateDir() {
  return (
    process.env.JARV1S_FLEET_STATE || path.join(os.homedir(), ".local", "state", "jarv1s-fleet")
  );
}

function tasksDir() {
  return path.join(stateDir(), "tasks");
}

function recordPath(issue) {
  return path.join(tasksDir(), `${issue}.json`);
}

function logPath() {
  return path.join(stateDir(), "log.jsonl");
}

// Atomic write: temp file in the same directory, then rename.
function writeFileAtomic(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`
  );
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

function appendLog(issue, msg) {
  fs.mkdirSync(stateDir(), { recursive: true });
  const line = JSON.stringify({ ts: new Date().toISOString(), issue, msg });
  // Single O_APPEND write; appending via temp-and-rename would drop concurrent lines.
  fs.appendFileSync(logPath(), `${line}\n`);
}

function parseIssue(raw) {
  if (!raw || !/^\d+$/.test(raw)) {
    throw usageError(`expected an issue number, got "${raw ?? ""}"`);
  }
  return Number(raw);
}

function readRecord(issue) {
  const file = recordPath(issue);
  if (!fs.existsSync(file)) {
    throw usageError(`no record for issue ${issue} (${file})`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeRecord(record) {
  writeFileAtomic(recordPath(record.issue), `${JSON.stringify(record, null, 2)}\n`);
}

function parsePairs(args) {
  const pairs = [];
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      throw usageError(`expected field=value, got "${arg}"`);
    }
    pairs.push([arg.slice(0, eq), arg.slice(eq + 1)]);
  }
  return pairs;
}

function validateTier(tier) {
  if (!TIERS.includes(tier)) {
    throw validationError(`tier must be one of ${TIERS.join(", ")}; got "${tier}"`);
  }
}

function cmdAdd(argv) {
  const issue = parseIssue(argv[0]);
  const fields = Object.fromEntries(parsePairs(argv.slice(1)));
  const extra = Object.keys(fields).filter((k) => k !== "spec" && k !== "tier");
  if (extra.length > 0) {
    throw usageError(`add only takes spec= and tier=; got ${extra.join(", ")}`);
  }
  if (!fields.spec || !fields.tier) {
    throw usageError("add requires spec=<path> and tier=<routine|sensitive|security>");
  }
  validateTier(fields.tier);
  if (fs.existsSync(recordPath(issue))) {
    throw validationError(`record for issue ${issue} already exists`);
  }
  const record = {
    issue,
    spec: fields.spec,
    tier: fields.tier,
    status: "queued",
    branch: null,
    worktree: null,
    pr: null,
    agent: null,
    relays: 0,
    qa_rounds: 0,
    blocked_reason: null,
    updated_at: new Date().toISOString()
  };
  writeRecord(record);
  appendLog(issue, `added: tier=${fields.tier} spec=${fields.spec} status=queued`);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

function cmdSet(argv) {
  const issue = parseIssue(argv[0]);
  const pairs = parsePairs(argv.slice(1));
  if (pairs.length === 0) {
    throw usageError("set requires at least one field=value pair");
  }
  const record = readRecord(issue);
  const changes = [];
  for (const [field, rawValue] of pairs) {
    if (!SETTABLE_FIELDS.has(field)) {
      throw validationError(`unknown field "${field}"`);
    }
    let value;
    if (rawValue === "+1") {
      if (!INCREMENT_FIELDS.has(field)) {
        throw validationError(`"+1" is only valid for relays and qa_rounds, not ${field}`);
      }
      value = (record[field] ?? 0) + 1;
    } else if (rawValue === "null" || rawValue === "") {
      value = null;
    } else if (INT_FIELDS.has(field)) {
      if (!/^\d+$/.test(rawValue)) {
        throw validationError(`${field} must be a number; got "${rawValue}"`);
      }
      value = Number(rawValue);
    } else {
      value = rawValue;
    }
    if (field === "status" && !STATUSES.includes(value)) {
      throw validationError(`status must be one of ${STATUSES.join(", ")}; got "${value}"`);
    }
    if (field === "tier" && value !== null) {
      validateTier(value);
    }
    record[field] = value;
    changes.push(`${field}=${value === null ? "null" : value}`);
  }
  record.updated_at = new Date().toISOString();
  writeRecord(record);
  appendLog(issue, `set ${changes.join(" ")}`);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

function cmdGet(argv) {
  const issue = parseIssue(argv[0]);
  const record = readRecord(issue);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
}

function readAllRecords() {
  const dir = tasksDir();
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .sort((a, b) => a.issue - b.issue);
}

function cmdList() {
  for (const r of readAllRecords()) {
    process.stdout.write(`${r.issue}\t${r.tier}\t${r.status}\t${r.pr ?? "-"}\t${r.updated_at}\n`);
  }
}

function cmdLog(argv) {
  const issue = parseIssue(argv[0]);
  const msg = argv.slice(1).join(" ").trim();
  if (!msg) {
    throw usageError("log requires a message");
  }
  readRecord(issue); // fail with exit 2 if the record does not exist
  appendLog(issue, msg);
}

// Derive the GitHub web URL from the repo this script lives in, so #NN and PR numbers
// can be real links. Falls back to plain text when the remote is unreadable.
function repoWebUrl() {
  try {
    const repoDir = path.dirname(fileURLToPath(import.meta.url));
    const remote = execFileSync("git", ["-C", repoDir, "config", "--get", "remote.origin.url"], {
      encoding: "utf8"
    }).trim();
    const match = remote.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/);
    if (match) {
      return `https://github.com/${match[1]}/${match[2]}`;
    }
  } catch {
    // No git or no remote; plain text is fine.
  }
  return null;
}

function readLogLines() {
  const file = logPath();
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((l) => l !== null);
}

function cmdBoard() {
  const records = readAllRecords();
  const webUrl = repoWebUrl();
  const issueLink = (n) => (webUrl ? `[#${n}](${webUrl}/issues/${n})` : `#${n}`);
  const prLink = (n) => (n == null ? "-" : webUrl ? `[#${n}](${webUrl}/pull/${n})` : `#${n}`);

  const lines = [];
  lines.push("# Fleet board");
  lines.push("");
  lines.push(`Generated ${new Date().toISOString()}.`);
  lines.push("");
  lines.push("| Issue | Tier | Status | PR | Relays | QA rounds | Blocked because |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of records) {
    lines.push(
      `| ${issueLink(r.issue)} | ${r.tier} | ${STATUS_LABELS[r.status] ?? r.status} | ` +
        `${prLink(r.pr)} | ${r.relays} | ${r.qa_rounds} | ${r.blocked_reason ?? "-"} |`
    );
  }
  if (records.length === 0) {
    lines.push("| - | - | - | - | - | - | - |");
  }
  lines.push("");
  lines.push("## Needs Ben");
  lines.push("");
  const blocked = records.filter((r) => r.status === "blocked");
  if (blocked.length === 0) {
    lines.push("Nothing right now.");
  } else {
    for (const r of blocked) {
      lines.push(`- ${issueLink(r.issue)}: ${r.blocked_reason ?? "no reason recorded"}`);
    }
  }
  lines.push("");
  lines.push("## Deputy rulings");
  lines.push("");
  const rulings = readLogLines().filter(
    (l) => typeof l.msg === "string" && l.msg.startsWith("DEPUTY")
  );
  if (rulings.length === 0) {
    lines.push("None.");
  } else {
    for (const l of rulings) {
      lines.push(`- ${l.ts} ${issueLink(l.issue)}: ${l.msg}`);
    }
  }
  lines.push("");
  writeFileAtomic(path.join(stateDir(), "board.md"), lines.join("\n"));
  process.stdout.write(`wrote ${path.join(stateDir(), "board.md")}\n`);
}

const USAGE = `usage:
  fleetctl add <issue> spec=<path> tier=<routine|sensitive|security>
  fleetctl set <issue> field=value ...   (relays=+1 and qa_rounds=+1 increment)
  fleetctl get <issue>
  fleetctl list
  fleetctl board
  fleetctl log <issue> <message>
`;

function main() {
  const [command, ...rest] = process.argv.slice(2);
  try {
    switch (command) {
      case "add":
        cmdAdd(rest);
        break;
      case "set":
        cmdSet(rest);
        break;
      case "get":
        cmdGet(rest);
        break;
      case "list":
        cmdList();
        break;
      case "board":
        cmdBoard();
        break;
      case "log":
        cmdLog(rest);
        break;
      default:
        process.stderr.write(USAGE);
        process.exit(2);
    }
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`fleetctl: ${err.message}\n`);
      process.exit(err.exitCode);
    }
    throw err;
  }
}

main();
