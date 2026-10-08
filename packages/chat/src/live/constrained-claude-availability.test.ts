import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import {
  CONSTRAINED_CLAUDE_VERSION,
  findConstrainedClaudeExecutable
} from "./constrained-claude-profile.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it("finds only an executable managed native install with the exact inspected version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-presence-"));
  directories.push(directory);
  const executable = join(directory, "native");
  // Intentionally not a valid program: the advisory probe must never execute it.
  await writeFile(executable, "This is a synthetic presence fixture, never a CLI.", {
    mode: 0o700
  });
  await symlink(executable, join(directory, "claude"));
  const metadata = {
    name: `@anthropic-ai/claude-code-linux-${process.arch}`,
    version: CONSTRAINED_CLAUDE_VERSION
  };
  expect(await findConstrainedClaudeExecutable(directory)).toBeUndefined();
  await writeFile(join(directory, "package.json"), JSON.stringify(metadata));
  expect(await findConstrainedClaudeExecutable(directory)).toBe(executable);
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ ...metadata, version: "0.0.0" })
  );
  expect(await findConstrainedClaudeExecutable(directory)).toBeUndefined();
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ ...metadata, name: "other-package" })
  );
  expect(await findConstrainedClaudeExecutable(directory)).toBeUndefined();
  await writeFile(join(directory, "package.json"), JSON.stringify(metadata));
  await chmod(executable, 0o600);
  expect(await findConstrainedClaudeExecutable(directory)).toBeUndefined();
  expect(await findConstrainedClaudeExecutable(".")).toBeUndefined();
});
