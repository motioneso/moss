import { lstat, readlink } from "node:fs/promises";
import { dirname } from "node:path";
import { gatewayFields } from "../../apps/api/src/computer/gateway-channel.js";
import { closureMetadata, overlaps } from "../computer-closure/config.js";
import { closureFile, recheckClosureFile, type ClosureFile } from "../computer-closure/files.js";
import { inspectRoots, type RootIdentity } from "../computer-host/config.js";
import { assertRoot, snapshotRoot } from "../computer-watchdog/linux-files.js";
import {
  assertNamespaceAnchors,
  assertSupervisorRuntime,
  assertTrustedPath,
  boundedFile,
  parseSupervisorConfiguration,
  sha256,
  supervisorError,
  type SupervisorConfiguration
} from "../computer-watchdog/trust.js";
import { signingHash, signingPath } from "./installation.js";

export interface SigningConfiguration {
  readonly artifactSha256: string;
  readonly supervisor: SupervisorConfiguration;
  readonly closureArtifactPath: string;
  readonly closureArtifactSha256: string;
  readonly nodeSha256: string;
  readonly netNamespace: string;
  readonly output: RootIdentity;
}
export interface SigningDeployment {
  readonly configuration: SigningConfiguration;
  readonly input: ClosureFile;
  readonly artifactPath: string;
  readonly anchors: string;
}
export function parseSigningConfiguration(value: unknown): SigningConfiguration {
  if (
    !gatewayFields(
      value,
      "artifactSha256,closureArtifactPath,closureArtifactSha256,netNamespace,nodeSha256,output,supervisor"
    ) ||
    ![value.artifactSha256, value.closureArtifactSha256, value.nodeSha256].every(signingHash) ||
    !signingPath(value.closureArtifactPath) ||
    typeof value.netNamespace !== "string" ||
    !/^net:\[[0-9]+\]$/.test(value.netNamespace) ||
    !gatewayFields(value.output, "dev,gid,ino,mode,path,uid")
  )
    throw supervisorError();
  const supervisor = parseSupervisorConfiguration(value.supervisor);
  const output = snapshotRoot(value.output as unknown as RootIdentity);
  if (supervisor.lifetime || output.uid !== 0 || (output.mode & 0o7777) !== 0o700)
    throw supervisorError();
  return Object.freeze({ ...value, supervisor, output }) as unknown as SigningConfiguration;
}

export async function loadSigningDeployment(
  path: string,
  artifactPath: string
): Promise<SigningDeployment> {
  assertSupervisorRuntime(true);
  await assertTrustedPath(path, false);
  if (((await lstat(dirname(path))).mode & 0o7777) !== 0o700) throw supervisorError();
  const input = await closureFile(path, 16384);
  const configuration = parseSigningConfiguration(JSON.parse(input.bytes.toString("utf8")));
  const { supervisor, output, closureArtifactPath } = configuration;
  const artifacts = [artifactPath, closureArtifactPath, process.execPath];
  const hashes = [
    configuration.artifactSha256,
    configuration.closureArtifactSha256,
    configuration.nodeSha256
  ];
  for (let i = 0; i < artifacts.length; i++) {
    await assertTrustedPath(artifacts[i]!, false);
    if (
      sha256(await boundedFile(artifacts[i]!, i === 2 ? 128 * 1024 ** 2 : 2 * 1024 ** 2)) !==
      hashes[i]
    )
      throw supervisorError();
  }
  await assertNamespaceAnchors(supervisor);
  for (const pid of ["self", "1"])
    if ((await readlink(`/proc/${pid}/ns/net`)) !== configuration.netNamespace)
      throw supervisorError();
  const hostRoots = await inspectRoots(supervisor.host);
  const trustedRoots = [
    supervisor.data,
    supervisor.dockerData,
    supervisor.monitor,
    ...(supervisor.capture ? [supervisor.capture] : [])
  ];
  for (const root of hostRoots) await assertRoot(root);
  for (const root of [...trustedRoots, output]) {
    await assertRoot(root);
    await assertTrustedPath(root.path, true);
  }
  const roots = [...hostRoots, ...trustedRoots];
  if (
    roots.some((root) => overlaps(root.path, output.path) || overlaps(output.path, root.path)) ||
    [path, ...artifacts].some(
      (item) => overlaps(output.path, item) || roots.some((root) => overlaps(root.path, item))
    )
  )
    throw supervisorError();
  const anchors = JSON.stringify({
    roots,
    artifacts: await Promise.all(artifacts.map(closureMetadata))
  });
  await recheckClosureFile(input);
  return Object.freeze({ configuration, input, artifactPath, anchors });
}

export async function revalidateSigningDeployment(deployment: SigningDeployment): Promise<void> {
  await recheckClosureFile(deployment.input);
  const current = await loadSigningDeployment(deployment.input.path, deployment.artifactPath);
  if (
    current.anchors !== deployment.anchors ||
    current.input.dev !== deployment.input.dev ||
    current.input.ino !== deployment.input.ino ||
    current.input.hash !== deployment.input.hash
  )
    throw supervisorError();
}
