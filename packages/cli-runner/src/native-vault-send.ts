import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { buildSanitizedCliEnv } from "./sanitized-env.js";
import { buildSetprivDropCommand } from "./setpriv.js";

const run = promisify(execFile);
const pending = new WeakMap<object, Promise<void>>();
interface Session {
  readonly userId: string;
  readonly identity: { readonly uid: number; readonly gid: number } | null;
  readonly child: { readonly stdin: { write(line: string): unknown } };
  lastActivity: number;
}

/** Keep the ACP pipe opaque. Refresh only the authenticated session owner's read grant,
 * before forwarding any line, so writes/chmod since the previous turn cannot leave stale masks.
 */
export function sendAcpLine(
  session: Session,
  line: string,
  maxBytes: number
): void | Promise<void> {
  if (line.length === 0 || line.length > maxBytes) {
    throw new Error("acpSend.line must be a non-empty line within 256 KiB");
  }
  if (line.includes("\n")) throw new Error("acpSend.line must be a single line");
  const write = () => {
    session.child.stdin.write(`${line}\n`);
    session.lastActivity = Date.now();
  };
  if (process.env.MOSS_NATIVE_VAULT_READS !== "1") return write();
  const next = (pending.get(session) ?? Promise.resolve()).then(async () => {
    if (!session.identity) throw new Error("Native vault reads require per-user isolation");
    const base = "/data/vaults";
    const owner = await stat(base);
    const script = createRequire(import.meta.url).resolve("./native-vault-prepare.ts");
    const { command, args } = buildSetprivDropCommand(
      process.execPath,
      ["--import", "tsx", script, session.userId, String(session.identity.uid)],
      { uid: owner.uid, gid: owner.gid }
    );
    await run(command, args, { env: buildSanitizedCliEnv(process.env), timeout: 30_000 });
    write();
  });
  pending.set(session, next);
  return next;
}
