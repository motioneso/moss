/** Actual tmux/process proof using only generated synthetic credentials; no provider calls. */
import { setTimeout as delay } from "node:timers/promises";
import { CliChatEngineHost } from "../../../packages/cli-runner/src/engine-host.js";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { validateFreshGeminiCredential } from "../../../packages/cli-runner/src/fresh-gemini-login.js";
import { scopedGeminiCredentialPath } from "../../../packages/cli-runner/src/gemini-credential-store.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LoginService } from "../../../packages/cli-runner/src/login-service.js";
import { LOGIN_ADAPTERS } from "../../../packages/cli-runner/src/login-adapters.js";
import { createSanitizedTmuxIo } from "../../../packages/cli-runner/src/runner-io.js";
import {
  persistProviderToken,
  providerTokenPath
} from "../../../packages/cli-runner/src/provider-token-store.js";
import {
  scopedClaudeTokenPath,
  validateFreshClaudeToken
} from "../../../packages/cli-runner/src/fresh-cli-login.js";

const home = await mkdtemp(path.join(tmpdir(), "workshop-fresh-proof-"));
const bin = path.join(home, "bin");
const token = `sk-ant-oat01-${"synthetic".repeat(8)}`;
const scope = { actorUserId: "proof-owner", providerConfigId: "proof-config" };
const sockets = new Set<string>();
let service: LoginService | undefined;
let host: CliChatEngineHost | undefined;
const originalToolsPrefix = process.env.JARVIS_CLI_TOOLS_PREFIX;
const originalPath = process.env.PATH;
const io = createSanitizedTmuxIo({
  HOME: home,
  PATH: `${bin}:/usr/bin:/bin`,
  TERM: "xterm-256color"
});
try {
  await mkdir(bin, { mode: 0o700 });
  const executable = path.join(bin, "claude");
  await writeFile(
    executable,
    `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--print')) {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN !== ${JSON.stringify(token)} || process.env.ANTHROPIC_API_KEY) process.exit(2);
  if (process.argv.includes('--output-format')) {
    process.stdin.resume();
    process.stdin.on('end', () => {
      const model = process.argv[process.argv.indexOf('--model') + 1];
      const init = { type: 'system', subtype: 'init', model, tools: [], mcp_servers: [] };
      const result = { type: 'result', subtype: 'success', is_error: false, structured_output: { proof: true } };
      fs.writeFileSync(1, JSON.stringify(init) + '\\n' + JSON.stringify(result) + '\\n'); process.exit(0);
    });
  } else { fs.writeFileSync(1, 'OK'); process.exit(0); }
  return;
}
if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.HOME === ${JSON.stringify(home)}) process.exit(3);
fs.writeFileSync(1, 'https://claude.ai/oauth/authorize?code=synthetic\\n');
require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
  fs.writeFileSync(1, ${JSON.stringify(token)} + '\\n'); process.exit(0);
});
`,
    { mode: 0o700 }
  );
  // If fresh tmux loads ambient config this marker executes, making the proof fail.
  await writeFile(
    path.join(home, ".tmux.conf"),
    `run-shell 'touch ${path.join(home, "ambient-loaded")}'\n`
  );
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  await persistProviderToken(home, "anthropic", "global-synthetic-not-provenance");
  service = new LoginService({
    io: {
      ...io,
      run: async (cmd, args, opts) => {
        if (cmd === "tmux" && args[0] === "-S") sockets.add(args[1]!);
        return io.run(cmd, args, opts);
      }
    },
    adapters: LOGIN_ADAPTERS,
    homeBase: home,
    probe: async () => {
      throw new Error("fresh login used global probe");
    },
    validateFreshToken: (freshHome, captured, signal) =>
      validateFreshClaudeToken(executable, freshHome, captured, signal),
    settleMs: 100,
    surfaceTimeoutMs: 3000,
    loginTimeoutMs: 10_000
  });
  const loginId = service.reserve("anthropic", scope);
  const begun = await service.start(loginId);
  assert.equal(begun.status, "awaiting_token");
  assert.match(begun.authorizationUrl ?? "", /^https:\/\/claude.ai\/oauth/);
  await assert.rejects(readFile(scopedClaudeTokenPath(home, scope)));
  const result = await service.submitToken("anthropic", loginId, "synthetic-code", scope);
  assert.deepEqual(result, { loginId, status: "ready" });
  assert.equal(await readFile(scopedClaudeTokenPath(home, scope), "utf8"), token);
  assert.equal(await readFile(providerTokenPath(home, "anthropic"), "utf8"), token);
  await assert.rejects(readFile(scopedClaudeTokenPath(home, { ...scope, actorUserId: "foreign" })));
  await assert.rejects(readFile(path.join(home, "ambient-loaded")));
  await service.startupSweep();
  process.env.JARVIS_CLI_TOOLS_PREFIX = home;
  host = new CliChatEngineHost({
    io,
    homeBase: home,
    neutralBase: path.join(home, "neutral"),
    singleUser: false,
    cliPresent: async () => true
  });
  const source = {
    provider: "anthropic" as const,
    model: "synthetic-source-model",
    personaText: "source data only",
    schema: { type: "object" },
    scope
  };
  for (const foreign of [
    { ...scope, actorUserId: "foreign" },
    { ...scope, providerConfigId: "foreign" }
  ]) {
    await assert.rejects(
      host.launchSourceGeneration("denied-source", { ...source, scope: foreign }),
      /credential is unavailable/
    );
  }
  await host.launchSourceGeneration("proof-source", source);
  await host.submitStructured("proof-source", "Produce synthetic source data.");
  let response = await host.readStructured("proof-source", 0);
  for (let i = 0; !response.complete && i < 80; i++) {
    await delay(25);
    response = await host.readStructured("proof-source", response.offset);
  }
  assert.equal(response.complete, true);
  assert.deepEqual(JSON.parse(response.text ?? "null"), { proof: true });
  await host.kill("proof-source");
  console.log(
    "PASS source consumption: exact scoped credential/model, foreign actor/config denied despite valid global token"
  );
  console.log(
    "PASS actual tmux: isolated HOME/config, immediate-exit token capture, fresh-token validation, exact scoped publication, cross-actor absence"
  );
  const geminiRecord = {
    account: "fixture@example.invalid",
    oauth: {
      access_token: "synthetic-gemini-access",
      refresh_token: "synthetic-gemini-refresh",
      token_type: "Bearer",
      expiry_date: Date.now() + 3600000
    }
  };
  await writeFile(
    path.join(bin, "gemini"),
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.HOME === ${JSON.stringify(home)}) process.exit(3);
const config = path.join(process.env.HOME, '.gemini');
if (fs.existsSync(path.join(config, 'oauth_creds.json'))) process.exit(4);
const settings = JSON.parse(fs.readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
if (settings.tools.core.length || settings.hooksConfig.enabled) process.exit(5);
fs.writeFileSync(1, 'https://accounts.google.com/o/oauth2/v2/auth?fixture=1\\n');
require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
  const record = ${JSON.stringify(geminiRecord)};
  fs.writeFileSync(path.join(config, 'oauth_creds.json'), JSON.stringify(record.oauth), {mode: 0o600});
  fs.writeFileSync(path.join(config, 'google_accounts.json'), JSON.stringify({active: record.account, old: []}), {mode: 0o600});
  process.exit(0);
});
`,
    { mode: 0o700 }
  );
  let validated = 0;
  const endpoint = createServer((req, res) => {
    if (
      req.method !== "GET" ||
      req.url !== "/oauth2/v2/userinfo" ||
      req.headers.authorization !== "Bearer synthetic-gemini-access"
    ) {
      res.writeHead(401);
      res.end();
      return;
    }
    validated++;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ email: geminiRecord.account, verified_email: true }));
  });
  const originalFetch = globalThis.fetch;
  endpoint.listen(0, "127.0.0.1");
  await once(endpoint, "listening");
  try {
    const address = endpoint.address();
    assert.ok(address && typeof address === "object");
    globalThis.fetch = (url, init) => {
      assert.equal(url, "https://www.googleapis.com/oauth2/v2/userinfo");
      return originalFetch(`http://127.0.0.1:${address.port}/oauth2/v2/userinfo`, init);
    };
    service = new LoginService({
      io: {
        ...io,
        run: async (cmd, args, opts) => {
          if (cmd === "tmux" && args[0] === "-S") sockets.add(args[1]!);
          return io.run(cmd, args, opts);
        }
      },
      adapters: LOGIN_ADAPTERS,
      homeBase: home,
      probe: async () => {
        throw new Error("fresh Gemini login used global probe");
      },
      validateFreshGemini: validateFreshGeminiCredential,
      settleMs: 100,
      surfaceTimeoutMs: 3000,
      loginTimeoutMs: 10000
    });
    const id = service.reserve("google", scope);
    const started = await service.start(id);
    assert.equal(started.status, "awaiting_token");
    assert.match(started.authorizationUrl ?? "", /^https:\/\/accounts.google.com\/o\/oauth2/);
    await assert.rejects(readFile(scopedGeminiCredentialPath(home, scope)));
    assert.deepEqual(await service.submitToken("google", id, "synthetic-code", scope), {
      loginId: id,
      status: "ready"
    });
    assert.equal(validated, 1);
    assert.deepEqual(
      JSON.parse(await readFile(scopedGeminiCredentialPath(home, scope), "utf8")),
      geminiRecord
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(home, ".gemini/oauth_creds.json"), "utf8")),
      geminiRecord.oauth
    );
    await assert.rejects(
      readFile(scopedGeminiCredentialPath(home, { ...scope, actorUserId: "foreign" }))
    );
    await assert.rejects(readFile(path.join(home, "ambient-loaded")));
    await service.startupSweep();
    console.log(
      "PASS actual Gemini login process: fresh native files, authenticated account check, scoped and ordinary publication, foreign scope absent"
    );
  } finally {
    globalThis.fetch = originalFetch;
    endpoint.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      endpoint.close((error) => (error ? reject(error) : resolve()))
    );
  }
} finally {
  await host?.kill("proof-source");
  if (originalToolsPrefix === undefined) delete process.env.JARVIS_CLI_TOOLS_PREFIX;
  else process.env.JARVIS_CLI_TOOLS_PREFIX = originalToolsPrefix;
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  await service?.startupSweep();
  for (const socket of sockets) {
    const stopped = await io.run("tmux", ["-S", socket, "kill-server"]);
    assert.ok(
      stopped.code === 0 ||
        /no server running|No such file or directory/.test(stopped.stderr ?? ""),
      "Owned proof socket cleanup failed"
    );
    await rm(socket, { force: true });
  }
  await rm(home, { recursive: true, force: true });
  console.log("PASS cleanup: only proof-owned home and sockets removed");
}
