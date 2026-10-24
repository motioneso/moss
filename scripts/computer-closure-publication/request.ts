import { gatewayFields } from "../../apps/api/src/computer/gateway-channel.js";
import type { RootIdentity } from "../computer-host/config.js";
import { snapshotRoot } from "../computer-watchdog/linux-files.js";
import { supervisorError } from "../computer-watchdog/trust.js";
import { signingHash, signingPath } from "../computer-signing/installation.js";

export interface ClosurePublicationRequest {
  readonly version: 1;
  readonly kind: "staged-closure-publication";
  readonly artifactSha256: string;
  readonly supervisorPath: string;
  readonly supervisorSha256: string;
  readonly closureArtifactPath: string;
  readonly closureArtifactSha256: string;
  readonly nodeSha256: string;
  readonly installationPath: string;
  readonly installationSha256: string;
  readonly publicKeySha256: string;
  readonly captureSha256: string;
  readonly netNamespace: string;
  readonly cgroupNamespace: string;
  readonly output: RootIdentity;
  readonly receipt: RootIdentity;
}

export function parseClosurePublicationRequest(value: unknown): ClosurePublicationRequest {
  if (
    !gatewayFields(
      value,
      "artifactSha256,captureSha256,cgroupNamespace,closureArtifactPath,closureArtifactSha256,installationPath,installationSha256,kind,netNamespace,nodeSha256,output,publicKeySha256,receipt,supervisorPath,supervisorSha256,version"
    ) ||
    value.version !== 1 ||
    value.kind !== "staged-closure-publication" ||
    ![
      value.artifactSha256,
      value.supervisorSha256,
      value.closureArtifactSha256,
      value.nodeSha256,
      value.installationSha256,
      value.publicKeySha256,
      value.captureSha256
    ].every(signingHash) ||
    ![value.supervisorPath, value.closureArtifactPath, value.installationPath].every(signingPath) ||
    typeof value.netNamespace !== "string" ||
    !/^net:\[[0-9]+\]$/.test(value.netNamespace) ||
    typeof value.cgroupNamespace !== "string" ||
    !/^cgroup:\[[0-9]+\]$/.test(value.cgroupNamespace)
  )
    throw supervisorError();
  const root = (item: unknown) => {
    if (!gatewayFields(item, "dev,gid,ino,mode,path,uid")) throw supervisorError();
    const result = snapshotRoot(item as unknown as RootIdentity);
    if (result.uid !== 0 || (result.mode & 0o7777) !== 0o700) throw supervisorError();
    return result;
  };
  return Object.freeze({
    ...value,
    output: root(value.output),
    receipt: root(value.receipt)
  }) as unknown as ClosurePublicationRequest;
}

export function publicationArguments(argv: readonly string[]): readonly [string, string] {
  if (argv.length !== 2 || !signingPath(argv[0]) || !signingHash(argv[1])) throw supervisorError();
  return [argv[0], argv[1]];
}
