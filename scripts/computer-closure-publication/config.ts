import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  closureMetadata,
  loadClosureInputs,
  overlaps,
  parseClosureConfiguration,
  type ClosureInputs
} from "../computer-closure/config.js";
import { assertCaptureJournal, loadPinnedClosureCapture } from "../computer-closure/capture.js";
import { closureFile, recheckClosureFile, type ClosureFile } from "../computer-closure/files.js";
import { inspectRoots } from "../computer-host/config.js";
import { captureNamespaceAnchors } from "../computer-capture/cgroups.js";
import { assertRoot } from "../computer-watchdog/linux-files.js";
import {
  assertSupervisorRuntime,
  assertTrustedPath,
  boundedFile,
  parseSupervisorConfiguration,
  sha256,
  supervisorError
} from "../computer-watchdog/trust.js";
import { parseSigningInstallation, signingHash } from "../computer-signing/installation.js";
import { parseClosurePublicationRequest, type ClosurePublicationRequest } from "./request.js";

export interface ClosurePublicationDeployment {
  readonly request: ClosurePublicationRequest;
  readonly input: ClosureFile;
  readonly supervisorFile: ClosureFile;
  readonly closure: ClosureInputs;
  readonly configPath: string;
  readonly artifactPath: string;
  readonly anchors: string;
}

async function privateInput(path: string, limit: number): Promise<ClosureFile> {
  await assertTrustedPath(path, false);
  if (((await lstat(dirname(path))).mode & 0o7777) !== 0o700) throw supervisorError();
  return closureFile(path, limit);
}

/** External hash is checked before parsing authority-bearing request fields. */
export async function loadClosurePublication(
  path: string,
  requestSha256: string,
  artifactPath: string
): Promise<ClosurePublicationDeployment> {
  assertSupervisorRuntime(true);
  if (!signingHash(requestSha256)) throw supervisorError();
  const input = await privateInput(path, 16384);
  if (input.hash !== requestSha256) throw supervisorError();
  const request = parseClosurePublicationRequest(JSON.parse(input.bytes.toString("utf8")));
  const supervisorFile = await privateInput(request.supervisorPath, 16384);
  if (supervisorFile.hash !== request.supervisorSha256) throw supervisorError();
  const supervisor = parseSupervisorConfiguration(
    JSON.parse(supervisorFile.bytes.toString("utf8"))
  );
  if (!supervisor.capture || !supervisor.lifetime) throw supervisorError();
  const artifacts = [artifactPath, request.closureArtifactPath, process.execPath];
  const hashes = [request.artifactSha256, request.closureArtifactSha256, request.nodeSha256];
  for (let i = 0; i < artifacts.length; i++) {
    await assertTrustedPath(artifacts[i]!, false);
    if (
      sha256(await boundedFile(artifacts[i]!, i === 2 ? 128 * 1024 ** 2 : 2 * 1024 ** 2)) !==
      hashes[i]
    )
      throw supervisorError();
  }
  const namespaces = await captureNamespaceAnchors();
  if (namespaces.net !== request.netNamespace || namespaces.cgroup !== request.cgroupNamespace)
    throw supervisorError();
  const installationFile = await privateInput(request.installationPath, 16384);
  if (installationFile.hash !== request.installationSha256) throw supervisorError();
  const installation = parseSigningInstallation(
    JSON.parse(installationFile.bytes.toString("utf8"))
  );
  const roots = await inspectRoots(supervisor.host);
  const protectedRoots = [
    ...roots,
    supervisor.data,
    supervisor.dockerData,
    supervisor.monitor,
    supervisor.capture,
    installation.output
  ];
  const paths = [
    path,
    request.supervisorPath,
    ...artifacts,
    request.installationPath,
    installation.signingKeyPath
  ];
  for (const root of [request.output, request.receipt]) {
    await assertRoot(root);
    await assertTrustedPath(root.path, true);
    if (
      protectedRoots.some(
        (other) => overlaps(root.path, other.path) || overlaps(other.path, root.path)
      ) ||
      paths.some((item) => overlaps(root.path, item) || overlaps(item, root.path))
    )
      throw supervisorError();
  }
  if (
    overlaps(request.output.path, request.receipt.path) ||
    overlaps(request.receipt.path, request.output.path)
  )
    throw supervisorError();
  await assertRoot(supervisor.capture);
  await assertTrustedPath(supervisor.capture.path, true);
  if ((supervisor.capture.mode & 0o7777) !== 0o700) throw supervisorError();
  const capture = await loadPinnedClosureCapture({ supervisor, ...request }, roots);
  const configuration = parseClosureConfiguration({
    supervisor,
    artifactSha256: request.closureArtifactSha256,
    processes: capture.processes,
    netNamespace: request.netNamespace,
    receipt: request.receipt,
    signingKeyPath: installation.signingKeyPath,
    publicKeySha256: request.publicKeySha256,
    installationPath: request.installationPath,
    installationSha256: request.installationSha256,
    captureSha256: request.captureSha256
  });
  const configPath = join(request.output.path, "closure.json");
  const closure = await loadClosureInputs(configuration, configPath, request.closureArtifactPath);
  await recheckClosureFile(capture.file);
  if (
    capture.file.dev !== closure.capture.file.dev ||
    capture.file.ino !== closure.capture.file.ino
  )
    throw supervisorError();
  const journal = await closureFile(join(supervisor.monitor.path, "observation.jsonl"), 512 * 1024);
  assertCaptureJournal(closure.capture, journal);
  await recheckClosureFile(input);
  await recheckClosureFile(supervisorFile);
  await recheckClosureFile(installationFile);
  return Object.freeze({
    request,
    input,
    supervisorFile,
    closure,
    configPath,
    artifactPath,
    anchors: JSON.stringify({
      publisher: await closureMetadata(artifactPath),
      inputs: closure.anchors,
      roots: closure.roots
    })
  });
}

/** Appended journal bytes may change; original capture/start-prefix and private inputs may not. */
export async function revalidateClosurePublication(
  deployment: ClosurePublicationDeployment
): Promise<void> {
  const originals = [
    deployment.input,
    deployment.supervisorFile,
    deployment.closure.installationFile,
    deployment.closure.keyFile,
    deployment.closure.capture.file
  ];
  for (const file of originals) await recheckClosureFile(file);
  const current = await loadClosurePublication(
    deployment.input.path,
    deployment.input.hash,
    deployment.artifactPath
  );
  const actual = [
    current.input,
    current.supervisorFile,
    current.closure.installationFile,
    current.closure.keyFile,
    current.closure.capture.file
  ];
  if (
    current.anchors !== deployment.anchors ||
    originals.some(
      (file, i) =>
        file.dev !== actual[i]!.dev ||
        file.ino !== actual[i]!.ino ||
        !file.bytes.equals(actual[i]!.bytes)
    )
  )
    throw supervisorError();
}
