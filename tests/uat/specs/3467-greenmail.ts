import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildUatComposeArgs } from "../provisioner.js";
const execFileAsync = promisify(execFile);
const GREENMAIL_OPTS =
  "-Dgreenmail.setup.test.imap -Dgreenmail.setup.test.smtp " +
  "-Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users.login=email " +
  "-Dgreenmail.users=probe:probe-pw@greenmail.test";

export async function startGreenmail(projectName: string): Promise<string> {
  const name = `${projectName}-greenmail`;
  await execFileAsync(
    "docker",
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--network",
      `${projectName}_jarv1s`,
      "--network-alias",
      "emailfixture",
      "--env",
      `GREENMAIL_OPTS=${GREENMAIL_OPTS}`,
      "greenmail/standalone:2.1.0"
    ],
    { maxBuffer: 1_000_000 }
  );

  const probe = `import net from "node:net";
await Promise.all([3143, 3025].map((port) => new Promise((resolve, reject) => {
  const socket = net.createConnection({ host: "emailfixture", port });
  socket.setTimeout(2_000);
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("timeout", () => { socket.destroy(); reject(new Error("fixture port timeout")); });
  socket.once("error", reject);
})));`;
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await execFileAsync(
        "docker",
        buildUatComposeArgs(projectName, [
          "exec",
          "-T",
          "jarv1s",
          "node",
          "--input-type=module",
          "-e",
          probe
        ]),
        { maxBuffer: 1_000_000 }
      );
      console.log(
        "[live proof] isolated GreenMail IMAP/SMTP ports are reachable on the UAT network"
      );
      return name;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await execFileAsync("docker", ["rm", "--force", name]);
  throw new Error(`GreenMail did not become ready on ${projectName}_jarv1`, { cause: lastError });
}
