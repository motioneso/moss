import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { decideReadOnly } from "../../.claude/hooks/allow-read-only.mjs";

const HOOK_PATH = fileURLToPath(
  new URL("../../.claude/hooks/allow-read-only.mjs", import.meta.url)
);
const HOME = homedir();
const REPO = `${HOME}/Jarv1s`;
const WORKTREES = `${HOME}/Jarv1s-wt`;
const CWD = `${REPO}/.claude/worktrees/fleet-lane-2021`;

function runHook(
  payload: unknown
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_PATH], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

// Every entry below is a command that was actually refused in this repo's stored sessions
// (274 refusals mined for issue #2021). If one of these starts failing, a build session has
// gone back to burning a turn on it.
const APPROVED: readonly (readonly [string, string])[] = [
  ["plain ls with stderr merged", "ls node_modules/.bin/tsc 2>&1"],
  ["step into a worktree first", `cd ${WORKTREES}/kevin-641 && ls node_modules 2>&1`],
  ["find with prune and print", "find . -path ./node_modules -prune -o -name '0*.sql' -print"],
  ["grep piped into head", 'grep -rn "resolvePolicy" packages/ai/src | head -20'],
  ["sed printing a line range", "sed -n '1,60p' packages/ai/src/gateway/policy.ts"],
  ["git naming the current branch", "git rev-parse --abbrev-ref HEAD"],
  ["disk usage of a few folders", "du -sh --exclude=.git .claude data outputs"],
  ["ls with a glob", "ls -d node_modules/.pnpm/pg-boss@*"],
  ["two reads joined by a semicolon", "cat package.json; echo done"],
  [
    "find under /tmp with stderr discarded",
    "find /tmp/audit-sports -type d -iname '*note*' -print 2>/dev/null"
  ],
  ["git log", "git log --oneline -5"],
  ["listing branches", "git branch --list"],
  ["listing branches with no arguments at all", "git branch"],
  ["listing tags", "git tag -l"],
  ["listing worktrees", "git worktree list"],
  ["listing the stash", "git stash list"],
  ["sorting a file to the screen", "sort -u notes.txt"],
  ["counting repeated lines", "uniq -c notes.txt"],
  ["sed with its script behind -e", "sed -n -e '1,5p' notes.txt"],
  ["reading a file under the working directory", `cat ${CWD}/package.json`],
  ["tail of a log in /tmp", "tail -n 40 /tmp/vf.log"],
  ["git log of one file in the repository", "git log --oneline -3 -- package.json"],
  ["git show with a format option that contains an equals sign", "git show --pretty=format:%h -s"],
  ["git diff of a path under the working directory", `git diff -- ${CWD}/package.json`]
];

// Each of these is a near miss for one of the approved commands. The rule name is asserted so a
// rejection that happens to land for the wrong reason still fails the test.
const REFUSED: readonly (readonly [string, string, string])[] = [
  ["find that deletes", "find . -name '*.tmp' -delete", "find-writes"],
  ["find that runs a command", "find . -name '*.ts' -exec rm {} \\;", "find-writes"],
  ["sed editing in place", "sed -i 's/a/b/' package.json", "sed-in-place"],
  ["sed whose script writes a file", "sed -n '1,5w /tmp/out' package.json", "sed-script-writes"],
  ["sed without -n", "sed 's/a/b/' package.json", "sed-needs-quiet"],
  ["ls redirected into a file", "ls > /tmp/listing.txt", "redirection"],
  [
    "cat of a command substitution",
    "cat $(git rev-parse --show-toplevel)/package.json",
    "command-substitution"
  ],
  ["cat of a backtick substitution", "cat `ls`", "command-substitution"],
  ["a read followed by a delete", "grep -rn foo . && rm -rf build", "not-approved"],
  ["reading a private key", "cat ~/.ssh/id_rsa", "path-outside-allowed-roots"],
  [
    "climbing out of the working directory",
    "cat ../../etc/passwd",
    "path-escapes-working-directory"
  ],
  ["switching branches", "git checkout main", "git-subcommand"],
  ["talking to the network with git", "git fetch origin", "git-subcommand"],
  ["downloading a page", "curl https://example.com", "not-approved"],
  ["piping into a delete", "ls | xargs rm", "banned-word"],
  ["a variable set in front of the command", "FOO=bar ls", "assignment-prefix"],
  ["a verification gate piped into tail", "pnpm verify:foundation | tail -20", "not-approved"],
  ["running in the background", "ls &", "background"],
  ["a subshell", "(cd /tmp && ls)", "subshell-or-group"],
  ["an unterminated quote", "grep -rn 'foo packages", "unparsable"],
  ["awk, which can write files", "awk '{print > \"out\"}' package.json", "not-approved"],
  ["cd as a later step", "ls && cd /tmp", "cd-not-first"],
  ["cd somewhere outside the allowed folders", "cd /etc && ls", "path-outside-allowed-roots"],
  ["git with a directory-changing global flag", "git -C /etc log", "git-global-flag"],
  ["a variable expansion we cannot check", "cat $SECRET_FILE", "expansion"],

  // Everything below was approved by the first version of this hook and found by review. Each one
  // is an option or an operand that turns a look-only command into one that writes.
  ["sort writing its result to a file", "sort --output=/tmp/out notes.txt", "option-writes-a-file"],
  ["sort writing with the short option", "sort -o notes.txt other.txt", "option-writes-a-file"],
  [
    "sort naming a program to run",
    "sort --compress-program=/tmp/evil notes.txt",
    "option-writes-a-file"
  ],
  [
    "ripgrep naming a program to run on every file",
    "rg --pre /tmp/evil.sh foo .",
    "option-writes-a-file"
  ],
  [
    "uniq, whose second file is where it writes",
    "uniq input.txt victim.ts",
    "uniq-writes-second-operand"
  ],
  [
    "sed editing in place under its long name with a suffix",
    "sed -n --in-place=.bak 's/a/b/' package.json",
    "sed-in-place"
  ],
  [
    "sed editing in place under a shortened long name",
    "sed -n --in-pl=.bak 's/a/b/' package.json",
    "sed-in-place"
  ],
  [
    "sed editing in place inside a bundle of flags",
    "sed -ni 's/a/b/' package.json",
    "sed-in-place"
  ],
  [
    "sed whose second script writes a file",
    "sed -n -e '1p' -e 'w /tmp/out' package.json",
    "sed-script-writes"
  ],
  [
    "sed taking its script from a file we cannot read",
    "sed -n -f script.sd input.txt",
    "sed-script-from-file"
  ],
  [
    "git diff writing the diff to a file",
    "git diff HEAD~1 --output=/tmp/anything",
    "git-writes-a-file"
  ],
  ["git log writing its output to a file", "git log --output=/tmp/anything", "git-writes-a-file"],
  // `git stash` on its own is not a listing, and every worktree on this box shares one stash stack.
  ["git stash on its own, which pockets your work", "git stash", "git-subcommand-mutates"],
  [
    "git branch list, which creates a branch called list",
    "git branch list",
    "git-subcommand-mutates"
  ],
  ["git tag list, which creates a tag called list", "git tag list", "git-subcommand-mutates"],
  ["git stash with a verb that drops work", "git stash pop", "git-subcommand-mutates"],

  // Round 2 of review: a git argument and an attached option value were both skipping the path
  // check, so either could still read a file outside the allowed folders.
  [
    "git printing a file from outside the allowed folders",
    "git log /etc/passwd",
    "path-outside-allowed-roots"
  ],
  [
    "git diff --no-index, which prints any two files on the box",
    "git diff --no-index /etc/passwd /etc/shadow",
    "path-outside-allowed-roots"
  ],
  [
    "git reading a path that climbs out of the working directory",
    "git log ../../etc/passwd",
    "path-escapes-working-directory"
  ],
  [
    "grep pointed outside the allowed folders by an attached option value",
    "grep --file=/etc/shadow .",
    "path-outside-allowed-roots"
  ],
  [
    "ripgrep pointed outside the allowed folders by an attached option value",
    "rg --file=/etc/shadow",
    "path-outside-allowed-roots"
  ]
];

describe("read-only command approval", () => {
  describe("approves the commands that were being refused", () => {
    for (const [name, command] of APPROVED) {
      it(name, () => {
        expect(decideReadOnly(command, CWD)).toEqual({ decision: "allow", rule: "read-only" });
      });
    }
  });

  describe("stays silent on anything that is not plainly read-only", () => {
    for (const [name, command, rule] of REFUSED) {
      it(`${name} (${rule})`, () => {
        expect(decideReadOnly(command, CWD)).toEqual({ decision: "none", rule });
      });
    }
  });

  it("treats an empty command as no opinion", () => {
    expect(decideReadOnly("", CWD).decision).toBe("none");
  });

  it("allows a path under the working directory it was given, and not the same path otherwise", () => {
    expect(decideReadOnly("cat /srv/build/notes.txt", "/srv/build")).toEqual({
      decision: "allow",
      rule: "read-only"
    });
    expect(decideReadOnly("cat /srv/build/notes.txt", CWD)).toEqual({
      decision: "none",
      rule: "path-outside-allowed-roots"
    });
  });
});

describe("read-only approval script, run as a real process", () => {
  it("prints an allow decision for an approved command", async () => {
    const result = await runHook({
      tool_name: "Bash",
      tool_input: { command: "ls node_modules 2>&1" },
      cwd: CWD
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: expect.any(String)
      }
    });
  });

  it("says nothing at all about a command it does not approve", async () => {
    const result = await runHook({
      tool_name: "Bash",
      tool_input: { command: "rm -rf build" },
      cwd: CWD
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("says nothing about a tool other than Bash", async () => {
    const result = await runHook({
      tool_name: "Read",
      tool_input: { file_path: "/etc/passwd" },
      cwd: CWD
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  // A hook that crashes must read as "no opinion", never as a refusal, or a bug in this file
  // would stop every shell command in a session.
  it("exits quietly on input that is not JSON", async () => {
    const result = await runHook("not json at all");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("exits quietly when there is no command in the payload", async () => {
    const result = await runHook({ tool_name: "Bash", tool_input: {} });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  });
});
