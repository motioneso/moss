import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Isolated proof only: substitute local endpoints at the actual engine's spawn boundary. */
export async function startSourceEngineProof({
  bundle,
  root,
  model,
  credential,
  executable,
  fixtureEnv
}) {
  const { createScopedSourceEngine, scopedGeminiCredentialPath } = await import(bundle);
  const scope = { actorUserId: "proof-owner", providerConfigId: "proof-config" };
  const credentialPath = scopedGeminiCredentialPath(root, scope);
  await mkdir(dirname(credentialPath), { recursive: true, mode: 0o700 });
  await writeFile(credentialPath, JSON.stringify(credential), { mode: 0o600 });
  const engine = createScopedSourceEngine(root, {
    provider: "google",
    model,
    schema: { type: "object" },
    personaText: "Produce source JSON only.",
    scope
  });
  const originalSpawn = childProcess.spawn;
  let child;
  let home;
  try {
    childProcess.spawn = (command, args, options) => {
      assert.equal(child, undefined, "Engine spawned more than one source process");
      assert.match(command, /(?:^|\/)gemini$/);
      assert.equal(args[args.indexOf("-m") + 1], model);
      assert.equal(options.detached, true);
      assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
      assert.deepEqual(Object.keys(options.env).sort(), [
        "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
        "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
        "HOME",
        "NO_BROWSER",
        "PATH",
        "TMPDIR"
      ]);
      home = options.env.HOME;
      assert.notEqual(home, root);
      child = originalSpawn(process.execPath, [executable, ...args], {
        ...options,
        env: { ...options.env, ...fixtureEnv }
      });
      return child;
    };
    syncBuiltinESMExports();
    await engine.launchStructured({
      model,
      schema: { type: "object" },
      personaText: "Produce source JSON only.",
      neutralDir: "unused",
      personaPath: "unused"
    });
    assert.ok(child);
    assert.deepEqual(await engine.readStructured(0), { offset: 0, complete: false });
    return {
      engine,
      child,
      home,
      credentialPath,
      async dispose() {
        await engine.kill();
        await assert.rejects(access(home));
      }
    };
  } catch (error) {
    await engine.kill();
    throw error;
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
}
