import { execFileSync } from "node:child_process";
import { buildUatComposeArgs } from "../compose-args.js";

/** Seed an authentic promoted CLI in this disposable stack; the updater itself is not under test. */
export function installPromotedMeetingCodex(projectName: string): void {
  if (!/^uat-[a-zA-Z0-9_]+$/.test(projectName)) throw new Error("Expected disposable UAT project");
  const receipt = execFileSync(
    "docker",
    [
      ...buildUatComposeArgs(projectName, ["exec", "-T", "--user", "1000:1000", "jarv1s"]),
      "node",
      "-e",
      `
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const provider = '/data/cli-tools/providers/openai-compatible';
const previous = fs.realpathSync(path.join(provider, 'current'));
const release = fs.mkdtempSync(path.join(provider, 'releases', 'meeting-uat-'));
execFileSync('npm', ['install', '--prefix', release, '--ignore-scripts', '--no-audit', '--no-fund', '@openai/codex@0.159.3'], { stdio: 'pipe', env: { PATH: process.env.PATH, HOME: '/tmp', npm_config_cache: '/tmp/meeting-uat-npm-cache' } });
const binary = path.join(release, 'node_modules', '.bin', 'codex');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
if (version !== 'codex-cli 0.159.3') throw new Error('Unexpected CLI fixture version');
const next = path.join(provider, 'meeting-uat-current');
fs.symlinkSync(release, next);
fs.renameSync(next, path.join(provider, 'current'));
console.log(JSON.stringify({version, retainedPrevious: fs.existsSync(previous)}));
`
    ],
    { encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 }
  );
  const result = JSON.parse(receipt) as { version: string; retainedPrevious: boolean };
  if (result.version !== "codex-cli 0.159.3" || !result.retainedPrevious)
    throw new Error("Promoted CLI fixture was not retained");
  console.log("MEETING_PROMOTED_CODEX_UAT version=0.159.3 previousRetained=true");
}
