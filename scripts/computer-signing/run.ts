import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { closureFile } from "../computer-closure/files.js";
import { assertEmptyOutput, ProvisionPublication } from "../computer-provision/publication.js";
import { computerMonotonicMs } from "../computer-watchdog/linux.js";
import { sha256, supervisorError } from "../computer-watchdog/trust.js";
import { revalidateSigningDeployment, type SigningDeployment } from "./config.js";
import { parseSigningInstallation, signingTemplateHash } from "./installation.js";

export const SIGNING_DEADLINE_MS = 60_000;
export interface SigningExecution {
  readonly startedAtMs: number;
  readonly now?: () => number;
  readonly interrupted: () => boolean;
}

/** Private signer delivery only. Native completion and independent installation acceptance remain required. */
export async function installClosureSigner(
  deployment: SigningDeployment,
  execution: SigningExecution
): Promise<0 | 2> {
  const now = execution.now ?? computerMonotonicMs;
  let last = execution.startedAtMs;
  const current = () => {
    const at = now();
    if (
      !Number.isSafeInteger(execution.startedAtMs) ||
      execution.startedAtMs < 0 ||
      !Number.isSafeInteger(at) ||
      at < last ||
      at - execution.startedAtMs >= SIGNING_DEADLINE_MS ||
      execution.interrupted()
    )
      throw supervisorError();
    last = at;
  };
  try {
    const publications: ProvisionPublication[] = [];
    const check = async () => {
      current();
      await revalidateSigningDeployment(deployment);
      for (const publication of publications) await publication.assertPublished();
      current();
    };
    await check();
    const { configuration: config } = deployment;
    await assertEmptyOutput(config.output);
    await check();
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicKeySha256 = sha256(publicKey.export({ type: "spki", format: "der" }));
    const signingKeyPath = join(config.output.path, "closure-key.pem");
    const key = await ProvisionPublication.create(
      config.output,
      "closure-key.pem",
      Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })),
      0o600,
      config.output.gid,
      check,
      current
    );
    publications.push(key);
    const readback = createPrivateKey((await closureFile(signingKeyPath, 4096)).bytes);
    if (
      readback.asymmetricKeyType !== "ed25519" ||
      sha256(createPublicKey(readback).export({ type: "spki", format: "der" })) !== publicKeySha256
    )
      throw supervisorError();
    await check();
    const installation = parseSigningInstallation({
      version: 1,
      kind: "closure-signing-installation",
      inputSha256: deployment.input.hash,
      installerArtifactSha256: config.artifactSha256,
      supervisorSha256: signingTemplateHash(config.supervisor),
      artifactPath: config.closureArtifactPath,
      artifactSha256: config.closureArtifactSha256,
      nodePath: process.execPath,
      nodeSha256: config.nodeSha256,
      bootId: config.supervisor.bootId,
      namespaces: { ...config.supervisor.namespaces, net: config.netNamespace },
      output: config.output,
      signingKeyPath,
      publicKeySha256
    });
    const manifest = await ProvisionPublication.create(
      config.output,
      "installation.json",
      installation,
      0o600,
      config.output.gid,
      check,
      current
    );
    publications.push(manifest);
    await check();
    const file = await closureFile(manifest.path, 16384);
    if (file.hash !== manifest.hash) throw supervisorError();
    parseSigningInstallation(JSON.parse(file.bytes.toString("utf8")));
    await check();
    current();
    return 0;
  } catch {
    // Deliberately retain every partial key/manifest; a retry refuses nonempty output.
    return 2;
  }
}
