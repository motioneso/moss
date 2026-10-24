import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import { gatewayFields } from "../../apps/api/src/computer/gateway-channel.js";
import { closureFile, recheckClosureFile, type ClosureFile } from "../computer-closure/files.js";
import { overlaps, closureMetadata } from "../computer-closure/config.js";
import { inspectRoots, type RootIdentity } from "../computer-host/config.js";
import { assertRoot, snapshotRoot } from "../computer-watchdog/linux-files.js";
import {
  assertSupervisorRuntime,
  assertTrustedPath,
  assertNamespaceAnchors,
  boundedFile,
  parseSupervisorConfiguration,
  sha256,
  supervisorError,
  type SupervisorConfiguration
} from "../computer-watchdog/trust.js";

export interface ProvisionConfiguration {
  readonly artifactSha256: string;
  readonly supervisor: SupervisorConfiguration;
  readonly supervisorArtifactPath: string;
  readonly output: RootIdentity;
}
export interface ProvisionDeployment {
  readonly configuration: ProvisionConfiguration;
  readonly input: ClosureFile;
  readonly artifactPath: string;
  readonly gateway: RootIdentity;
  readonly anchors: string;
}
export function parseProvisionConfiguration(value: unknown): ProvisionConfiguration {
  if (
    !gatewayFields(value, "artifactSha256,output,supervisor,supervisorArtifactPath") ||
    typeof value.artifactSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.artifactSha256) ||
    typeof value.supervisorArtifactPath !== "string" ||
    !isAbsolute(value.supervisorArtifactPath) ||
    normalize(value.supervisorArtifactPath) !== value.supervisorArtifactPath ||
    !gatewayFields(value.output, "dev,gid,ino,mode,path,uid")
  )
    throw supervisorError();
  const supervisor = parseSupervisorConfiguration(value.supervisor);
  if (supervisor.lifetime) throw supervisorError();
  const output = snapshotRoot(value.output as unknown as RootIdentity);
  if (output.uid !== 0 || (output.mode & 0o7777) !== 0o700) throw supervisorError();
  return Object.freeze({
    artifactSha256: value.artifactSha256,
    supervisor,
    supervisorArtifactPath: value.supervisorArtifactPath,
    output
  });
}
export async function loadProvisionDeployment(
  path: string,
  artifactPath: string
): Promise<ProvisionDeployment> {
  assertSupervisorRuntime(true);
  await assertTrustedPath(path, false);
  if (((await lstat(dirname(path))).mode & 0o7777) !== 0o700) throw supervisorError();
  const input = await closureFile(path, 16384);
  const configuration = parseProvisionConfiguration(JSON.parse(input.bytes.toString("utf8")));
  const { supervisor, output, supervisorArtifactPath } = configuration;
  const artifacts = [process.execPath, artifactPath, supervisorArtifactPath];
  for (const item of artifacts) await assertTrustedPath(item, false);
  if (
    sha256(await boundedFile(artifactPath, 2 * 1024 ** 2)) !== configuration.artifactSha256 ||
    sha256(await boundedFile(supervisorArtifactPath, 2 * 1024 ** 2)) !== supervisor.artifactSha256
  )
    throw supervisorError();
  await assertNamespaceAnchors(supervisor);
  await assertTrustedPath(output.path, true);
  await assertRoot(output);
  const roots = await inspectRoots(supervisor.host);
  const gateway = roots.find((r) => r.path === supervisor.host.gatewayConfigDir);
  if (!gateway || gateway.uid !== 0 || gateway.gid !== 1000 || (gateway.mode & 0o7777) !== 0o750)
    throw supervisorError();
  await assertTrustedPath(gateway.path, true);
  const all = [...roots, supervisor.data, supervisor.dockerData, supervisor.monitor];
  if (
    all.some((root) => overlaps(root.path, output.path) || overlaps(output.path, root.path)) ||
    [path, ...artifacts].some(
      (item) => overlaps(output.path, item) || all.some((root) => overlaps(root.path, item))
    )
  )
    throw supervisorError();
  const anchors = JSON.stringify({
    roots,
    artifacts: await Promise.all(artifacts.map(closureMetadata)),
    nodeHash: sha256(await boundedFile(process.execPath, 128 * 1024 ** 2))
  });
  await recheckClosureFile(input);
  return Object.freeze({ configuration, input, artifactPath, gateway, anchors });
}
export async function revalidateProvisionDeployment(
  deployment: ProvisionDeployment
): Promise<void> {
  await recheckClosureFile(deployment.input);
  const current = await loadProvisionDeployment(deployment.input.path, deployment.artifactPath);
  if (
    current.anchors !== deployment.anchors ||
    current.input.dev !== deployment.input.dev ||
    current.input.ino !== deployment.input.ino ||
    current.input.hash !== deployment.input.hash
  )
    throw supervisorError();
}
