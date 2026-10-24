import { join, isAbsolute, normalize } from "node:path";
import { gatewayFields } from "../../apps/api/src/computer/gateway-channel.js";
import { isUuid } from "../../apps/api/src/computer/host-contract.js";
import { type RootIdentity } from "../computer-host/config.js";
import { snapshotRoot } from "../computer-watchdog/linux-files.js";
import {
  sha256,
  supervisorError,
  type SupervisorConfiguration
} from "../computer-watchdog/trust.js";

export interface SigningInstallation {
  readonly version: 1;
  readonly kind: "closure-signing-installation";
  readonly inputSha256: string;
  readonly installerArtifactSha256: string;
  readonly supervisorSha256: string;
  readonly artifactPath: string;
  readonly artifactSha256: string;
  readonly nodePath: string;
  readonly nodeSha256: string;
  readonly bootId: string;
  readonly namespaces: Readonly<Record<"pid" | "mnt" | "user" | "net", string>>;
  readonly output: RootIdentity;
  readonly signingKeyPath: string;
  readonly publicKeySha256: string;
}

export const signingHash = (v: unknown): v is string =>
  typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
export const signingPath = (v: unknown): v is string =>
  typeof v === "string" && isAbsolute(v) && normalize(v) === v;

/** Both callers hash the same parser result, omitting only the receiver secret/binding. */
export function signingTemplateHash(supervisor: SupervisorConfiguration): string {
  const { lifetime: _lifetime, ...template } = supervisor;
  return sha256(Buffer.from(JSON.stringify(template)));
}

export function parseSigningInstallation(value: unknown): SigningInstallation {
  if (
    !gatewayFields(
      value,
      "artifactPath,artifactSha256,bootId,inputSha256,installerArtifactSha256,kind,namespaces,nodePath,nodeSha256,output,publicKeySha256,signingKeyPath,supervisorSha256,version"
    ) ||
    value.version !== 1 ||
    value.kind !== "closure-signing-installation" ||
    !isUuid(value.bootId) ||
    ![
      value.inputSha256,
      value.installerArtifactSha256,
      value.supervisorSha256,
      value.artifactSha256,
      value.nodeSha256,
      value.publicKeySha256
    ].every(signingHash) ||
    ![value.artifactPath, value.nodePath, value.signingKeyPath].every(signingPath) ||
    !gatewayFields(value.namespaces, "mnt,net,pid,user") ||
    !Object.entries(value.namespaces).every(
      ([key, v]) => typeof v === "string" && new RegExp(`^${key}:\\[[0-9]+\\]$`).test(v)
    ) ||
    !gatewayFields(value.output, "dev,gid,ino,mode,path,uid")
  )
    throw supervisorError();
  const output = snapshotRoot(value.output as unknown as RootIdentity);
  if (
    output.uid !== 0 ||
    (output.mode & 0o7777) !== 0o700 ||
    value.signingKeyPath !== join(output.path, "closure-key.pem")
  )
    throw supervisorError();
  return Object.freeze({
    ...value,
    output,
    namespaces: Object.freeze({ ...value.namespaces })
  }) as unknown as SigningInstallation;
}
