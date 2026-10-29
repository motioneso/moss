import * as fs from "node:fs/promises";
import { join } from "node:path";
import { captureFixture } from "./computer-capture-fixture.js";
import { signingFixture } from "./computer-signing-fixture.js";
import * as trust from "../../scripts/computer-watchdog/trust.js";
import { loadClosurePublication } from "../../scripts/computer-closure-publication/config.js";
import {
  PublicationClock,
  publishClosureConfiguration
} from "../../scripts/computer-closure-publication/run.js";
import type { ClosurePublicationRequest } from "../../scripts/computer-closure-publication/request.js";

/** Actual capture/signer/publisher/loader; inherited OS/root/runtime/PID1/cgroup/heartbeat/Node projections. */
export async function closurePublicationFixture(register: (close: () => Promise<void>) => void) {
  const f = await captureFixture(register);
  await f.run();
  const capturePath = join(f.capture, "capture.json");
  const capture = JSON.parse(await fs.readFile(capturePath, "utf8"));
  const pin = async (path: string) => {
    const { dev, ino, uid, gid, mode } = await f.io.lstat(path);
    return { path, dev, ino, uid, gid, mode };
  };
  const artifact = join(f.root, "input/closure.cjs");
  const publisher = join(f.root, "input/publisher.cjs");
  await fs.writeFile(artifact, "/* disclosed verifier code fixture */", { mode: 0o600 });
  await fs.writeFile(publisher, "/* disclosed publisher code fixture */", { mode: 0o600 });
  for (const name of ["closure-output", "receipt"])
    await fs.mkdir(join(f.root, name), { mode: 0o700 });
  const supervisor = f.deployment.configuration;
  const signing = await signingFixture(
    f.root,
    supervisor,
    capture.provenance.namespaces.net,
    artifact
  );
  if ((await signing.install()) !== 0) throw new Error("Signer fixture failed");
  const installed = await signing.read();
  const supervisorPath = join(f.root, "input/publication-supervisor.json");
  await fs.writeFile(supervisorPath, JSON.stringify(supervisor), { mode: 0o600 });
  const request: ClosurePublicationRequest = {
    version: 1,
    kind: "staged-closure-publication",
    artifactSha256: trust.sha256(await fs.readFile(publisher)),
    supervisorPath,
    supervisorSha256: trust.sha256(await fs.readFile(supervisorPath)),
    closureArtifactPath: artifact,
    closureArtifactSha256: trust.sha256(await fs.readFile(artifact)),
    nodeSha256: trust.sha256(await trust.boundedFile(process.execPath, 128 * 1024 ** 2)),
    installationPath: installed.installationPath,
    installationSha256: installed.installationSha256,
    publicKeySha256: installed.installation.publicKeySha256,
    captureSha256: trust.sha256(await fs.readFile(capturePath)),
    netNamespace: capture.provenance.namespaces.net,
    cgroupNamespace: capture.provenance.namespaces.cgroup,
    output: await pin(join(f.root, "closure-output")),
    receipt: await pin(join(f.root, "receipt"))
  };
  const path = join(f.root, "input/publication-request.json");
  const save = () => fs.writeFile(path, JSON.stringify(request), { mode: 0o600 });
  await save();
  const hash = async () => trust.sha256(await fs.readFile(path));
  const load = async () => loadClosurePublication(path, await hash(), publisher);
  const publish = async () =>
    publishClosureConfiguration(
      await load(),
      new PublicationClock(
        0,
        () => false,
        () => 1
      )
    );
  const stop = async () => {
    const original = f.store.state;
    await fs.writeFile(
      join(f.host.stateDir, "stop.json"),
      JSON.stringify({
        schemaVersion: 1,
        reason: "operator-stop",
        instanceId: f.host.instanceId,
        roots: f.deployment.roots,
        state: original
      }),
      { mode: 0o600 }
    );
    await f.store.save({ ...original, enabled: false, generation: original.generation + 1 });
    await f.journal.collector(f.descendant);
    await f.journal.stop(f.startedAtMs + 1, "operator-stop", f.descendant);
    await f.store.close();
  };
  // Only isolated conflicting-root negatives use an altered, exactly re-signed template.
  const resign = async (supervisor: typeof f.deployment.configuration) => {
    const root = join(f.root, "alternate-signer");
    await fs.mkdir(root, { mode: 0o700 });
    const signer = await signingFixture(root, supervisor, request.netNamespace, artifact);
    if ((await signer.install()) !== 0) throw new Error("Altered signer fixture failed");
    const installed = await signer.read();
    await fs.writeFile(supervisorPath, JSON.stringify(supervisor));
    Object.assign(request, {
      supervisorSha256: trust.sha256(await fs.readFile(supervisorPath)),
      installationPath: installed.installationPath,
      installationSha256: installed.installationSha256,
      publicKeySha256: installed.installation.publicKeySha256
    });
    await save();
  };
  return {
    f,
    request,
    path,
    hash,
    save,
    load,
    publish,
    stop,
    publisher,
    artifact,
    pin,
    capture,
    capturePath,
    signing,
    resign
  };
}
