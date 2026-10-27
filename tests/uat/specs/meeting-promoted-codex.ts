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
// The runner sweeps unreferenced releases when another CLI session ends. Install outside
// releases, then pin both real releases for this disposable container's lifetime.
const staging = fs.mkdtempSync('/data/cli-tools/meeting-uat-stage-');
const release = path.join(provider, 'releases', path.basename(staging));
const initStat = fs.readFileSync('/proc/1/stat', 'utf8');
const initStart = initStat.slice(initStat.lastIndexOf(')') + 2).split(' ')[19];
if (!/^\\d+$/.test(initStart)) throw new Error('Cannot pin disposable CLI fixture');
const pin = (dir) => {
  if (path.dirname(dir) !== path.join(provider, 'releases')) return;
  const leases = path.join(provider, 'leases', path.basename(dir));
  fs.mkdirSync(leases, { recursive: true });
  fs.writeFileSync(path.join(leases, '1-' + initStart), '');
};
pin(previous);
try {
execFileSync('npm', ['install', '--prefix', staging, '--ignore-scripts', '--no-audit', '--no-fund', '@openai/codex@0.159.3'], { stdio: 'pipe', env: { PATH: process.env.PATH, HOME: '/tmp', npm_config_cache: '/tmp/meeting-uat-npm-cache' } });
const binary = path.join(staging, 'node_modules', '.bin', 'codex');
const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
if (version !== 'codex-cli 0.159.3') throw new Error('Unexpected CLI fixture version');
// Match InstallService.stageNpmRelease: published roots must be traversable by isolated UIDs.
fs.chmodSync(staging, 0o755);
pin(release);
fs.renameSync(staging, release);
const next = path.join(provider, 'meeting-uat-current');
fs.symlinkSync(release, next);
fs.renameSync(next, path.join(provider, 'current'));
console.log(JSON.stringify({version, retainedPrevious: fs.existsSync(previous)}));
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
`
    ],
    { encoding: "utf8", timeout: 180_000, maxBuffer: 1024 * 1024 }
  );
  const result = JSON.parse(receipt) as { version: string; retainedPrevious: boolean };
  if (result.version !== "codex-cli 0.159.3" || !result.retainedPrevious)
    throw new Error("Promoted CLI fixture was not retained");
  console.log("MEETING_PROMOTED_CODEX_UAT version=0.159.3 previousRetained=true");
}
