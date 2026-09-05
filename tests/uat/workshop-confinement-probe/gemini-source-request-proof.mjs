// Pinned public CLI + loopback Gemini API fixture. Run in a network-none disposable container.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startOAuthFixture } from "./gemini-oauth-fixture.mjs";
import { startSourceEngineProof } from "./gemini-source-engine-fixture.mjs";

const executable = process.argv[2];
assert.ok(executable, "Pass the pinned Gemini bundle entry path");
const manifest = JSON.parse(
  await readFile(join(dirname(dirname(executable)), "package.json"), "utf8")
);
assert.equal(manifest.version, "0.57.0", "Policy evidence applies only to Gemini 0.57.0");
const root = await mkdtemp("/tmp/workshop-gemini-request-");
assert.ok(
  process.argv[3] === undefined ||
    ["--model-matrix", "--oauth-matrix", "--source-launch", "--source-engine"].includes(
      process.argv[3]
    )
);
const sourceEngineBundle = process.argv[3] === "--source-engine" ? process.argv[4] : undefined;
const sourceFactory =
  process.argv[3] === "--source-launch"
    ? (await import(process.argv[4])).createGeminiSourceLaunch
    : undefined;
let cases =
  process.argv[3] === "--oauth-matrix"
    ? [
        {
          mode: "fresh-home",
          model: "gemini-2.5-flash",
          requestModel: "gemini-2.5-flash",
          pin: true,
          oauth: true
        },
        {
          mode: "fresh-home",
          model: "gemini-2.5-pro",
          requestModel: "gemini-2.5-pro",
          pin: true,
          oauth: true
        },
        {
          mode: "fresh-home",
          model: "gemini-2.5-flash",
          requestModel: "gemini-2.5-flash",
          pin: true,
          oauth: true,
          refresh: true
        },
        {
          mode: "fresh-home",
          model: "gemini-2.5-flash",
          requestModel: "gemini-2.5-flash",
          pin: true,
          oauth: true,
          missingCredential: true
        },
        {
          mode: "fresh-home",
          model: "gemini-2.5-flash",
          requestModel: "gemini-2.5-flash",
          pin: true,
          oauth: true,
          remoteAdmin: true
        },
        {
          mode: "fresh-home",
          model: "gemini-2.5-flash",
          requestModel: "gemini-2.5-flash",
          pin: true,
          oauth: true,
          remoteAdmin: true,
          fixedExperiments: true
        },
        {
          mode: "fresh-home",
          model: "gemini-2.5-flash",
          requestModel: "gemini-2.5-flash",
          pin: true,
          oauth: true,
          remoteAdmin: true,
          emptyMcpAllowed: true
        },
        {
          mode: "fresh-home",
          model: "gemini-2.5-flash",
          requestModel: "gemini-2.5-flash",
          pin: true,
          oauth: true,
          remoteAdmin: true,
          denyAllMcp: true
        },
        {
          mode: "fresh-home",
          model: "gemini-2.5-flash",
          requestModel: "gemini-2.5-flash",
          pin: true,
          oauth: true,
          remoteAdmin: true,
          denyAllMcp: true,
          remoteServerName: "workshop-source-disabled"
        }
      ]
    : process.argv[3] === "--model-matrix"
      ? [
          {
            mode: "fresh-home",
            model: "gemini-2.5-flash",
            requestModel: "gemini-3.5-flash",
            pin: false
          },
          {
            mode: "fresh-home",
            model: "gemini-2.5-flash",
            requestModel: "gemini-2.5-flash",
            pin: true
          },
          {
            mode: "fresh-home",
            model: "gemini-2.5-pro",
            requestModel: "gemini-2.5-pro",
            pin: true
          },
          {
            mode: "fresh-home",
            model: "gemini-3-pro-preview",
            requestModel: "gemini-3-pro-preview",
            pin: true
          },
          {
            mode: "fresh-home",
            model: "gemini-3-pro-preview",
            requestModel: "gemini-3-pro-preview",
            pin: true,
            errorStatus: 404
          },
          {
            mode: "fresh-home",
            model: "gemini-2.5-flash",
            requestModel: "gemini-2.5-flash",
            pin: true,
            errorStatus: 403
          }
        ]
      : ["unrestricted", "project-only", "system-override", "fresh-home"].map((mode) => ({
          mode,
          model: "gemini-3.5-flash",
          requestModel: "gemini-3.5-flash",
          pin: false
        }));
if (sourceFactory || sourceEngineBundle)
  cases = [
    {
      sourcePolicy: true,
      mode: "fresh-home",
      model: "gemini-2.5-flash",
      requestModel: "gemini-2.5-flash",
      pin: true,
      oauth: true,
      remoteAdmin: true,
      denyAllMcp: true
    },
    {
      sourcePolicy: true,
      mode: "fresh-home",
      model: "gemini-2.5-pro",
      requestModel: "gemini-2.5-pro",
      pin: true,
      oauth: true,
      remoteAdmin: true,
      denyAllMcp: true,
      refresh: true
    },
    {
      sourcePolicy: true,
      mode: "fresh-home",
      model: "gemini-2.5-flash",
      requestModel: "gemini-2.5-flash",
      pin: true,
      oauth: true,
      remoteAdmin: true,
      denyAllMcp: true,
      forceTool: true
    }
  ];
if (sourceEngineBundle) cases.push({ ...cases[1], cancelSource: true });
const secret = "WORKSHOP_SYNTHETIC_PRIVATE_SENTINEL";
let child;
let timer;
let server;
let oauthFixture;
let sourceLaunch;
let engineProof;
const oauthToken = "workshop-synthetic-oauth-access";
const stop = () => {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
try {
  if (cases.some((item) => item.oauth)) oauthFixture = await startOAuthFixture(root, oauthToken);
  for (const {
    mode,
    model,
    requestModel,
    pin,
    errorStatus,
    oauth,
    refresh,
    missingCredential,
    remoteAdmin,
    fixedExperiments,
    emptyMcpAllowed,
    denyAllMcp,
    remoteServerName = "fixture",
    sourcePolicy = false,
    forceTool = false,
    cancelSource = false
  } of cases) {
    let cancelled;
    const oauthRequestOffset = oauthFixture?.requestCount ?? 0;
    const restricted = mode === "system-override" || mode === "fresh-home";
    const remoteContactExpected = !!(remoteAdmin && !fixedExperiments && !denyAllMcp);
    const run = join(
      root,
      `${mode}-${model}-${pin}-${errorStatus ?? "ok"}-${refresh}-${missingCredential}-${remoteAdmin}-${fixedExperiments}-${emptyMcpAllowed}-${denyAllMcp}-${remoteServerName}-${forceTool}-${cancelSource}`
    );
    const home = join(run, "home");
    const cwd = join(run, "neutral");
    await mkdir(join(home, ".gemini"), { recursive: true, mode: 0o700 });
    await mkdir(join(cwd, ".gemini"), { recursive: true, mode: 0o700 });
    const sentinel = join(cwd, "private-fixture.txt");
    await writeFile(sentinel, secret, { mode: 0o600 });
    const markerScript = join(run, "marker.cjs");
    const hookMarker = join(run, "hook-ran");
    const mcpMarker = join(run, "mcp-ran");
    await writeFile(markerScript, "require('node:fs').writeFileSync(process.argv[2], 'ran');");
    await writeFile(
      join(home, ".gemini", "settings.json"),
      JSON.stringify({
        security: { auth: { selectedType: "gemini-api-key" } },
        privacy: { usageStatisticsEnabled: false },
        telemetry: { enabled: false },
        general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
        advanced: { autoConfigureMemory: false },
        hooksConfig: { enabled: true },
        hooks: {
          SessionStart: [
            {
              hooks: [
                { type: "command", command: `${process.execPath} ${markerScript} ${hookMarker}` }
              ]
            }
          ]
        },
        mcpServers: {
          fixture: { command: process.execPath, args: [markerScript, mcpMarker], timeout: 1000 }
        }
      })
    );
    await writeFile(
      join(cwd, ".gemini", "settings.json"),
      JSON.stringify(mode !== "unrestricted" ? { tools: { core: [] } } : {})
    );
    await writeFile(
      join(run, "system-settings.json"),
      JSON.stringify(
        restricted
          ? {
              ...(pin
                ? {
                    experimental: { dynamicModelConfiguration: true },
                    modelConfigs: {
                      modelIdResolutions: { [model]: { default: model, contexts: [] } }
                    }
                  }
                : {}),
              tools: { core: [] },
              ...(emptyMcpAllowed ? { mcp: { allowed: [] } } : {}),
              ...(denyAllMcp
                ? {
                    mcp: {
                      allowed: ["workshop-source-disabled"],
                      excluded: ["workshop-source-disabled"]
                    }
                  }
                : {}),
              hooksConfig: { enabled: false },
              privacy: { usageStatisticsEnabled: false },
              telemetry: { enabled: false },
              general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
              advanced: { autoConfigureMemory: false },
              admin: {
                mcp: { enabled: false },
                extensions: { enabled: false },
                skills: { enabled: false }
              }
            }
          : {}
      )
    );
    const selectedHome = mode === "fresh-home" ? join(run, "fresh-home") : home;
    if (mode === "fresh-home") {
      await mkdir(join(selectedHome, ".gemini"), { recursive: true, mode: 0o700 });
      await writeFile(
        join(selectedHome, ".gemini", "settings.json"),
        JSON.stringify({
          security: { auth: { selectedType: oauth ? "oauth-personal" : "gemini-api-key" } }
        })
      );
    }
    if (oauth) {
      // A valid native credential outside the selected HOME must not rescue a missing selected-home credential.
      await writeFile(
        join(home, ".gemini", "oauth_creds.json"),
        JSON.stringify({
          access_token: oauthToken,
          refresh_token: "synthetic-refresh",
          token_type: "Bearer",
          expiry_date: Date.now() + 3_600_000
        }),
        { mode: 0o600 }
      );
    }
    if (oauth && !missingCredential) {
      await writeFile(
        join(selectedHome, ".gemini", "oauth_creds.json"),
        JSON.stringify({
          access_token: oauthToken,
          refresh_token: "synthetic-refresh",
          token_type: "Bearer",
          expiry_date: refresh ? 1 : Date.now() + 3_600_000
        }),
        { mode: 0o600 }
      );
      await writeFile(
        join(selectedHome, ".gemini", "google_accounts.json"),
        JSON.stringify({
          active: "fixture@example.invalid",
          old: []
        }),
        { mode: 0o600 }
      );
    }
    await writeFile(join(run, "system-defaults.json"), "{}");
    if (fixedExperiments) await writeFile(join(run, "experiments.json"), "{}");
    const requests = [];
    const oauthMethods = new Set();
    const mcpMethods = new Set();
    let failure;
    server = createServer(async (req, res) => {
      try {
        assert.ok(req.method === "POST" || (oauth && req.method === "GET"));
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          assert.ok(size <= 1_048_576);
          chunks.push(chunk);
        }
        let body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (req.url === "/mcp") {
          mcpMethods.add(body.method ?? req.method);
          assert.ok(remoteContactExpected, "Unexpected remote MCP contact");
          assert.equal(req.headers.authorization, undefined, "Provider credential reached MCP");
          if (req.method === "GET") {
            res.writeHead(405).end();
            return;
          }
          if (body.method === "notifications/initialized") {
            res.writeHead(202).end();
            return;
          }
          let result;
          if (body.method === "initialize")
            result = {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "synthetic-remote-mcp", version: "1.0.0" }
            };
          else if (body.method === "tools/list")
            result = {
              tools: [
                {
                  name: "synthetic_remote_tool",
                  description: "Synthetic remote action",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false }
                }
              ]
            };
          else {
            assert.equal(body.method, "tools/call");
            assert.equal(body.params.name, "synthetic_remote_tool");
            await writeFile(mcpMarker, "ran");
            result = { content: [{ type: "text", text: "REMOTE_MCP_EXECUTED" }] };
          }
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
          return;
        }
        if (oauth) {
          assert.equal(req.headers.authorization, `Bearer ${oauthToken}`);
          const method = req.url.split(":").at(-1).split("?")[0];
          oauthMethods.add(method);
          const replies = {
            loadCodeAssist: {
              cloudaicompanionProject: "synthetic-project",
              currentTier: { id: "free-tier", name: "Free" }
            },
            fetchAdminControls: remoteAdmin
              ? {
                  adminControlsApplicable: true,
                  strictModeDisabled: true,
                  mcpSetting: {
                    mcpEnabled: true,
                    mcpConfigJson: JSON.stringify({
                      requiredMcpServers: {
                        [remoteServerName]: {
                          url: `http://127.0.0.1:${server.address().port}/mcp`,
                          type: "http",
                          timeout: 1000
                        }
                      }
                    })
                  }
                }
              : {},
            listExperiments: { flags: remoteAdmin ? [{ flagId: 45752213, boolValue: true }] : [] },
            retrieveUserQuota: { buckets: [] },
            getCodeAssistGlobalUserSetting: {},
            recordCodeAssistMetrics: {}
          };
          if (Object.hasOwn(replies, method)) {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(replies[method]));
            return;
          }
        }
        if (req.url.includes(":countTokens")) {
          res.setHeader("content-type", "application/json");
          res.end('{"totalTokens":10}');
          return;
        }
        if (oauth) {
          assert.match(req.url, /:(?:streamGenerateContent|generateContent)(?:\?|$)/);
          assert.equal(body.model, requestModel);
          body = body.request;
        } else assert.match(req.url, new RegExp(`/models/${requestModel}:`));
        requests.push(body);
        if (sourcePolicy)
          assert.ok(
            JSON.stringify(body.contents).includes("source-policy-task"),
            "Source stdin task was lost"
          );
        assert.ok(requests.length <= 3, "Unexpected extra model request");
        const names = (body.tools ?? []).flatMap((tool) =>
          (tool.functionDeclarations ?? []).map((fn) => fn.name)
        );
        if (restricted) {
          assert.deepEqual(names, [], "Candidate still advertises tools");
          assert.ok(
            (body.tools ?? []).every((tool) =>
              Object.keys(tool).every((key) => key === "functionDeclarations")
            ),
            "Unexpected built-in provider tool"
          );
        } else assert.ok(names.includes("read_file"), "Negative control did not expose read_file");
        if (cancelSource) {
          cancelled = engineProof.engine.kill();
          await cancelled;
          res.destroy();
          return;
        }
        if (errorStatus) {
          res.statusCode = errorStatus;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: {
                code: errorStatus,
                message: "Synthetic model unavailable",
                status: errorStatus === 404 ? "NOT_FOUND" : "PERMISSION_DENIED"
              }
            })
          );
          return;
        }
        if (requests.length === 2) {
          const serialized = JSON.stringify(body.contents);
          assert.equal(
            serialized.includes(secret),
            !restricted,
            "Native tool read did not match the expected policy"
          );
          assert.ok(!serialized.includes("REMOTE_MCP_EXECUTED"), "Remote MCP tool executed");
          if (restricted)
            assert.match(serialized, /not found|not available|unknown|not registered/i);
        }
        const parts =
          requests.length === 1 && (!sourcePolicy || forceTool)
            ? [
                {
                  functionCall:
                    remoteContactExpected || emptyMcpAllowed || denyAllMcp
                      ? { name: `mcp_${remoteServerName}_synthetic_remote_tool`, args: {} }
                      : { name: "read_file", args: { file_path: sentinel } }
                }
              ]
            : [{ text: '{"word":"quasar"}' }];
        const result = {
          candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
          modelVersion: requestModel
        };
        if (req.url.includes(":streamGenerateContent")) {
          res.setHeader("content-type", "text/event-stream");
          res.end(`data: ${JSON.stringify(oauth ? { response: result } : result)}\n\n`);
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(oauth ? { response: result } : result));
        }
      } catch (error) {
        failure = error;
        res.statusCode = 400;
        res.end();
        stop();
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    let output = "";
    const stdout = [];
    const credentialRecord = {
      account: "fixture@example.invalid",
      oauth: {
        access_token: oauthToken,
        refresh_token: "synthetic-refresh",
        token_type: "Bearer",
        expiry_date: refresh ? 1 : Date.now() + 3_600_000
      }
    };
    const fixtureEnv = oauth
      ? {
          ...oauthFixture.env,
          ...(fixedExperiments ? { GEMINI_EXP: join(run, "experiments.json") } : {}),
          CODE_ASSIST_ENDPOINT: `http://127.0.0.1:${port}`,
          GOOGLE_CLOUD_PROJECT: "synthetic-project"
        }
      : { GEMINI_API_KEY: "synthetic-only", GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}` };
    if (sourcePolicy && !sourceEngineBundle) {
      await writeFile(join(run, "credential.json"), JSON.stringify(credentialRecord), {
        mode: 0o600
      });
      sourceLaunch = await sourceFactory(
        {
          model,
          schema: {
            type: "object",
            properties: { word: { type: "string" } },
            required: ["word"],
            additionalProperties: false
          }
        },
        join(run, "credential.json")
      );
    }
    if (sourceEngineBundle) {
      engineProof = await startSourceEngineProof({
        bundle: sourceEngineBundle,
        root: run,
        model,
        credential: credentialRecord,
        executable,
        fixtureEnv
      });
      child = engineProof.child;
    } else
      child = spawn(
        process.execPath,
        [
          executable,
          ...(sourceLaunch?.args ?? [
            "-p",
            "Return source JSON only.",
            "-o",
            "stream-json",
            "--approval-mode",
            "yolo",
            "--skip-trust",
            "-m",
            model
          ])
        ],
        {
          cwd: sourceLaunch?.cwd ?? cwd,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...(sourceLaunch?.env ?? {
              HOME: selectedHome,
              PATH: process.env.PATH,
              TMPDIR: run,
              GEMINI_CLI_SYSTEM_SETTINGS_PATH: join(run, "system-settings.json"),
              GEMINI_CLI_SYSTEM_DEFAULTS_PATH: join(run, "system-defaults.json")
            }),
            ...fixtureEnv,
            NO_BROWSER: "1"
          }
        }
      );
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        output += chunk.toString();
        if (stream === child.stdout) stdout.push(chunk);
        if (output.length > 65_536) stop();
      });
    timer = setTimeout(stop, 45_000);
    const closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (engineProof) await engineProof.engine.submitStructured("source-policy-task");
    else child.stdin.end(sourceLaunch?.encodePrompt("source-policy-task"));
    const code = await closed;
    clearTimeout(timer);
    if (failure) {
      console.error(
        JSON.stringify({
          oauthMethods: [...oauthMethods],
          mcpMethods: [...mcpMethods],
          diagnostic: output
            .split("\n")
            .filter((line) => /mcp|required|blocked|error/i.test(line))
            .join("\n")
            .slice(-1500)
            .replaceAll(oauthToken, "[synthetic-token]")
            .replaceAll("synthetic-refresh", "[synthetic-refresh]")
        })
      );
      throw failure;
    }
    if (cancelSource) {
      assert.ok(cancelled, "Source request did not reach the cancellation boundary");
      await cancelled;
      assert.equal(code, null);
      assert.equal(requests.length, 1);
      assert.ok(!output.includes("quasar"), "Cancelled source returned success");
    } else if (missingCredential) {
      assert.equal(
        typeof code,
        "number",
        "Missing selected-home credential did not fail before deadline"
      );
      assert.notEqual(code, 0, "CLI accepted a missing selected-home credential");
      assert.deepEqual(requests, [], "Missing selected-home credential reached source generation");
    } else if (errorStatus) {
      assert.equal(
        typeof code,
        "number",
        "CLI did not terminate on provider error before deadline"
      );
      assert.notEqual(code, 0, "CLI accepted a failed provider request");
      assert.ok(requests.length >= 1 && requests.length <= 3);
      assert.ok(!output.includes("quasar"), "CLI returned synthetic success after provider error");
    } else {
      assert.equal(code, 0, `CLI failed: ${output.slice(-2500)}`);
      assert.equal(
        requests.length,
        sourcePolicy && !forceTool ? 1 : 2,
        `Unexpected source round trips: ${output.slice(-1000)}`
      );
      assert.match(output, /quasar/);
    }
    if (engineProof) {
      assert.equal(await engineProof.engine.isAlive(), false);
      if (forceTool || cancelSource) {
        await assert.rejects(
          engineProof.engine.readStructured(0),
          cancelSource ? /stopped/ : /failed policy validation/
        );
        assert.deepEqual(
          JSON.parse(await readFile(engineProof.credentialPath, "utf8")),
          credentialRecord
        );
      } else {
        const result = await engineProof.engine.readStructured(0);
        assert.equal(result.complete, true);
        assert.equal(result.text, '{"word":"quasar"}');
        const native = JSON.parse(
          await readFile(join(engineProof.home, ".gemini", "oauth_creds.json"), "utf8")
        );
        assert.deepEqual(JSON.parse(await readFile(engineProof.credentialPath, "utf8")), {
          account: credentialRecord.account,
          oauth: native
        });
        if (refresh) assert.ok(native.expiry_date > Date.now());
        assert.deepEqual(await engineProof.engine.readStructured(0), result);
      }
      console.log(
        `PASS source-engine: selected=${model}, native-refresh=${!!refresh}, forced-tool=${forceTool}, cancelled=${cancelSource}, result=${cancelSource ? "cancelled" : forceTool ? "rejected" : "accepted"}, scoped-publication=${!forceTool && !cancelSource}`
      );
    } else if (sourcePolicy) {
      const text = Buffer.concat(stdout).toString("utf8");
      if (forceTool) {
        await assert.rejects(sourceLaunch.readResult(text), /failed policy validation/);
        await assert.rejects(sourceLaunch.readRefreshedCredential(), /credential is unavailable/);
      } else {
        assert.equal(await sourceLaunch.readResult(text), '{"word":"quasar"}');
        const refreshed = await sourceLaunch.readRefreshedCredential();
        assert.equal(refreshed.account, credentialRecord.account);
        assert.deepEqual(
          refreshed.oauth,
          JSON.parse(
            await readFile(join(sourceLaunch.env.HOME, ".gemini", "oauth_creds.json"), "utf8")
          )
        );
        if (refresh) assert.ok(refreshed.oauth.expiry_date > Date.now());
      }
      assert.deepEqual(
        JSON.parse(await readFile(join(run, "credential.json"), "utf8")),
        credentialRecord
      );
      console.log(
        `PASS source-launch: selected=${model}, native-refresh=${!!refresh}, forced-tool=${forceTool}, result=${forceTool ? "rejected" : "accepted"}`
      );
    }
    const init = output.split("\n").flatMap((line) => {
      try {
        const record = JSON.parse(line);
        return record.type === "init" ? [record] : [];
      } catch {
        return [];
      }
    });
    assert.equal(init.length, missingCredential ? 0 : 1, "Unexpected CLI init record count");
    if (!missingCredential)
      assert.equal(init[0].model, model, "Unexpected reported model selector");
    assert.equal(await readFile(sentinel, "utf8"), secret);
    if (oauth) {
      oauthFixture.verify(oauthRequestOffset, missingCredential, refresh);
      if (remoteAdmin)
        assert.equal(
          oauthMethods.has("fetchAdminControls"),
          !fixedExperiments,
          "Unexpected remote-admin fetch policy"
        );
      assert.ok(
        !output.includes(oauthToken) && !output.includes("synthetic-refresh"),
        "Credential appeared in CLI output"
      );
      if (refresh && !cancelSource) {
        const updated = JSON.parse(
          await readFile(
            join(
              engineProof?.home ?? sourceLaunch?.env.HOME ?? selectedHome,
              ".gemini",
              "oauth_creds.json"
            ),
            "utf8"
          )
        );
        assert.ok(
          updated.expiry_date > Date.now(),
          "Refreshed native credential was not persisted"
        );
      }
    }
    if (remoteAdmin)
      assert.equal(
        mcpMethods.has("tools/list"),
        remoteContactExpected,
        "Unexpected remote MCP discovery"
      );
    const mcpRuns = mode !== "fresh-home";
    for (const marker of [hookMarker, mcpMarker]) {
      const ran = await readFile(marker, "utf8").catch(() => undefined);
      assert.equal(
        ran,
        (marker === hookMarker ? !restricted : mcpRuns) ? "ran" : undefined,
        `Ambient execution mismatch in ${mode}: ${marker.endsWith("hook-ran") ? "hook" : "MCP"}`
      );
    }
    console.log(
      `PASS ${mode}: tools=${restricted ? "absent" : "exposed"}, native-read=${errorStatus || missingCredential || remoteAdmin ? "not-attempted" : restricted ? "denied" : "allowed"}, hook=${restricted ? "blocked" : "ran"}, MCP=${mcpRuns ? "ran" : "blocked"}; selector=${model}, request=${requests.length ? requestModel : "none"}, pinned=${pin}, provider=${errorStatus ?? "success"}, auth=${oauth ? "native-oauth" : "api-key"}, refresh=${!!refresh}, missing=${!!missingCredential}, remote-admin=${!!remoteAdmin}, fixed-experiments=${!!fixedExperiments}, empty-mcp-allowed=${!!emptyMcpAllowed}, deny-all-MCP=${!!denyAllMcp}, remote-server=${remoteServerName}, remote-MCP-contact=${mcpMethods.size > 0}`
    );
    await new Promise((resolve) => server.close(resolve));
    server = undefined;
    child = undefined;
    await engineProof?.dispose();
    engineProof = undefined;
    await sourceLaunch?.dispose();
    sourceLaunch = undefined;
  }
} finally {
  clearTimeout(timer);
  if (engineProof) await engineProof.dispose();
  else stop();
  await new Promise((resolve) => server?.close(resolve) ?? resolve());
  await oauthFixture?.close();
  await sourceLaunch?.dispose();
  await rm(root, { recursive: true, force: true });
  console.log("PASS cleanup: synthetic homes, server and child group removed");
}
