import { execFileSync } from "node:child_process";
import { buildUatComposeArgs } from "../compose-args.js";

/** Seed the official npm release of a promoted CLI (version-checked) in this disposable stack; the updater itself is not under test. */
export function installPromotedMeetingClaude(projectName: string): void {
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
const provider = '/data/cli-tools/providers/anthropic';
const previous = fs.realpathSync(path.join(provider, 'current'));
const release = fs.mkdtempSync(path.join(provider, 'releases', 'meeting-uat-'));
execFileSync('npm', ['install', '--prefix', release, '--ignore-scripts', '--no-audit', '--no-fund', '@anthropic-ai/claude-code@2.1.286'], { stdio: 'pipe', env: { PATH: process.env.PATH, HOME: '/tmp', npm_config_cache: '/tmp/meeting-uat-npm-cache' } });
// Match InstallService.placeArchBinary: --ignore-scripts leaves the stub wrapper in place.
const wrapper = path.join(release, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
const native = path.join(release, 'node_modules', '@anthropic-ai', 'claude-code-linux-' + (process.arch === 'arm64' ? 'arm64' : 'x64'), 'claude');
fs.rmSync(wrapper, { force: true });
fs.symlinkSync(path.relative(path.dirname(wrapper), native), wrapper);
fs.chmodSync(native, 0o755);
const binary = path.join(release, 'node_modules', '.bin', 'claude');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
if (version !== '2.1.286 (Claude Code)') throw new Error('Unexpected CLI fixture version');
// Match InstallService.stageNpmRelease: published roots must be traversable by isolated UIDs.
fs.chmodSync(release, 0o755);
const next = path.join(provider, 'meeting-uat-current');
fs.symlinkSync(release, next);
fs.renameSync(next, path.join(provider, 'current'));
console.log(JSON.stringify({version, retainedPrevious: fs.existsSync(previous)}));
`
    ],
    { encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 }
  );
  const result = JSON.parse(receipt) as { version: string; retainedPrevious: boolean };
  if (result.version !== "2.1.286 (Claude Code)" || !result.retainedPrevious)
    throw new Error("Promoted CLI fixture was not retained");
  console.log("MEETING_PROMOTED_CLAUDE_UAT version=2.1.286 previousRetained=true");
}
