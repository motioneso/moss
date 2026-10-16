import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildUatComposeArgs } from "./compose-args.js";

export interface N3ObserverOption {
  readonly nonce: string;
  readonly bootstrapSha256: string;
  readonly schema: 1;
  readonly deadline: number;
}
export interface UatProvisionOptions {
  readonly n3Observer?: N3ObserverOption;
  /** A port reserved by devports for this isolated live run. */
  readonly claimedWebPort?: number;
  readonly excludeChunks?: readonly string[];
  readonly withoutNewsJsonBinding?: boolean;
  // #1306 Task 22: opt-in, absent by default, same shape as the Codex credential copy's own
  // "no-op unless the host has a login" trigger. Job Search enables both the fixture origin and
  // its scoring provider; ESPN enables only the shared origin for deterministic ESPN responses.
  readonly withJobSearchFixture?: boolean;
  readonly withEspnFixture?: boolean;
  // [task:p8-briefing-writer-unreachable]: opt-in, absent by default. Enables the writer
  // fixture origin and its synthesis provider, so briefing cards render fixed prose.
  readonly withBriefingWriterFixture?: boolean;
  readonly withClassifierFixture?: boolean;
  readonly withClassifierMcpFixture?: boolean;
  readonly withNewsFeedbackFixture?: boolean;
  /** #1909: opt-in recovery fixtures used only by its dedicated live-path spec. */
  readonly withSportsPublicSourceFixtures?: boolean;
  /** #2015: opt-in pending workflow approval used only by its live-path spec. */
  readonly withWorkflowApprovalFixture?: boolean;
  /** #2175: opt-in seeded audit-log rows used only by the Activity outcomes live-path spec. */
  readonly withActivityOutcomeFixture?: boolean;
  /** #2267: opt-in trusted owner-draft fixture used only by the Workshop storage proof. */
  readonly withWorkshopStorageFixture?: boolean;
  /** #1121 Task 4: an id from UAT_CHAT_SCRIPTS (tests/uat/seed/types.ts). Threads to
   *  composeSeedHook's chatScript ctx field, and (when set) writes JARVIS_UAT_SCRIPTED_PROVIDER_BIN
   *  (#1659 defect 4) so the container's profile.d script puts the scripted-provider fixture's
   *  own bin/ ahead of the real tools bin on PATH — never JARVIS_CLI_TOOLS_PREFIX, which the
   *  production installer also owns. */
  readonly chatScript?: string;
}

export const N3_BOOTSTRAP_PATH = "/app/tests/uat/n3-fallback-observer-bootstrap.mjs";
const sourcePath = "tests/uat/n3-fallback-observer-bootstrap.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));
const hex = /^[a-f0-9]{64}$/;
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const fail = (): never => {
  throw new Error("N3 observer provisioning validation failed");
};
const remaining = (option: N3ObserverOption) => {
  const ms = option.deadline - Date.now();
  if (ms <= 0) return fail();
  return Math.min(ms, 2147483647);
};

/** No inherited loader/provider choices; the omitted option leaves existing env bytes alone. */
export function n3ObserverEnv(
  option: N3ObserverOption | undefined,
  chatScript?: string,
  env: NodeJS.ProcessEnv = process.env
): readonly string[] {
  if (option === undefined) return [];
  if (
    !option ||
    Object.getPrototypeOf(option) !== Object.prototype ||
    Reflect.ownKeys(option).length !== 4 ||
    Reflect.ownKeys(option).some(
      (key) =>
        typeof key !== "string" ||
        !["nonce", "bootstrapSha256", "schema", "deadline"].includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(option, key)!, "value")
    ) ||
    typeof option.nonce !== "string" ||
    !hex.test(option.nonce) ||
    typeof option.bootstrapSha256 !== "string" ||
    !hex.test(option.bootstrapSha256) ||
    option.schema !== 1 ||
    !Number.isSafeInteger(option.deadline) ||
    option.deadline <= Date.now() ||
    chatScript !== undefined ||
    env.NODE_OPTIONS !== undefined ||
    env.JARVIS_UAT_SCRIPTED_PROVIDER_BIN !== undefined ||
    env.JARVIS_UAT_SEED_CHAT_SCRIPT !== undefined ||
    Object.keys(env).some((key) => key.startsWith("MOSS_N3_OBSERVER_"))
  )
    return fail();
  return [
    `NODE_OPTIONS=--import=${N3_BOOTSTRAP_PATH}`,
    `MOSS_N3_OBSERVER_NONCE=${option.nonce}`,
    `MOSS_N3_OBSERVER_SHA256=${option.bootstrapSha256}`,
    "MOSS_N3_OBSERVER_SCHEMA=1",
    `MOSS_N3_OBSERVER_DEADLINE=${option.deadline}`
  ];
}

export type N3Capture = (
  command: "git" | "docker",
  args: readonly string[],
  deadline: number
) => Promise<Buffer>;
const exec = promisify(execFile);
const capture: N3Capture = async (command, args, deadline) => {
  try {
    const ms = deadline - Date.now();
    if (ms <= 0) return fail();
    const result = await exec(command, [...args], {
      cwd: root,
      encoding: "buffer",
      timeout: Math.min(ms, 2147483647),
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, NODE_OPTIONS: undefined }
    });
    return result.stdout;
  } catch {
    return fail();
  }
};

/** docker cp emits one regular-file tar member; never extract paths or execute image code. */
function copiedFile(tar: Buffer, max: number): Buffer {
  if (tar.length < 1024 || tar.length > max + 4096) return fail();
  const header = tar.subarray(0, 512);
  if (header[156] !== 0 && header[156] !== 48) return fail();
  const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0/g, "").trim();
  if (!/^[0-7]+$/.test(sizeText)) return fail();
  const size = Number.parseInt(sizeText, 8);
  const end = 512 + Math.ceil(size / 512) * 512;
  let sum = 0;
  for (let index = 0; index < 512; index++)
    sum += index >= 148 && index < 156 ? 32 : header[index]!;
  const checksum = Number.parseInt(
    header.subarray(148, 156).toString("ascii").replace(/\0/g, "").trim(),
    8
  );
  if (
    !size ||
    size > max ||
    end + 1024 > tar.length ||
    checksum !== sum ||
    tar.subarray(end).some((byte) => byte !== 0)
  )
    return fail();
  return tar.subarray(512, 512 + size);
}

export interface N3Prepared {
  readonly beforeInitialStart: (input: {
    readonly projectName: string;
    readonly envPath: string;
    readonly recordCreated: () => Promise<void>;
  }) => Promise<void>;
  readonly checkDeadline: () => void;
}

/** No resource owner is introduced: Compose creates once; the existing producer observes it. */
async function prepareObserver(
  option: N3ObserverOption | undefined,
  chatScript?: string,
  dependencies: {
    readonly capture?: N3Capture;
    readonly env?: NodeJS.ProcessEnv;
    readonly readSource?: () => Buffer;
  } = {}
): Promise<N3Prepared | undefined> {
  if (option === undefined) return undefined;
  n3ObserverEnv(option, chatScript, dependencies.env);
  const pinned = Object.freeze({ ...option });
  const run = dependencies.capture ?? capture;
  const readSource = dependencies.readSource ?? (() => readFileSync(join(root, sourcePath)));
  const invoke = async (command: "git" | "docker", args: readonly string[]) => {
    remaining(pinned);
    try {
      const result = await run(command, args, pinned.deadline);
      remaining(pinned);
      return result;
    } catch {
      return fail();
    }
  };
  if (
    hash(readSource()) !== pinned.bootstrapSha256 ||
    hash(await invoke("git", ["show", `HEAD:${sourcePath}`])) !== pinned.bootstrapSha256
  )
    return fail();
  const commit = (await invoke("git", ["rev-parse", "HEAD"])).toString().trim();
  if (
    !/^[a-f0-9]{40}$/.test(commit) ||
    (await invoke("git", ["status", "--porcelain", "--untracked-files=normal"])).length
  )
    return fail();
  return {
    checkDeadline: () => {
      remaining(pinned);
    },
    beforeInitialStart: async ({ projectName, envPath, recordCreated }) => {
      // This split precedes the original up step; up must retain this exact created identity.
      await invoke("docker", buildUatComposeArgs(projectName, ["create", "jarv1s"]));
      await recordCreated();
      const id = (
        await invoke("docker", buildUatComposeArgs(projectName, ["ps", "-a", "-q", "jarv1s"]))
      )
        .toString()
        .trim();
      if (!hex.test(id)) return fail();
      const inspect = async () => {
        const result: unknown = JSON.parse(
          (
            await invoke("docker", ["container", "inspect", id, "--format", "{{json .}}"])
          ).toString()
        );
        if (!result || typeof result !== "object" || Array.isArray(result)) return fail();
        return result as {
          Id?: unknown;
          Image?: unknown;
          State?: { Status?: unknown };
          Config?: { Env?: unknown; Image?: unknown };
          Mounts?: unknown;
        };
      };
      const info = await inspect();
      if (
        info.Id !== id ||
        typeof info.Image !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(info.Image) ||
        info.State?.Status !== "created"
      )
        return fail();
      const image = (
        await invoke("docker", [
          "image",
          "inspect",
          String(info.Config?.Image),
          "--format",
          "{{.Id}}"
        ])
      )
        .toString()
        .trim();
      if (image !== info.Image) return fail();
      const envStat = lstatSync(envPath),
        dirStat = lstatSync(dirname(envPath));
      if (
        !envStat.isFile() ||
        (envStat.mode & 0o777) !== 0o600 ||
        !dirStat.isDirectory() ||
        (dirStat.mode & 0o777) !== 0o700 ||
        envStat.uid !== dirStat.uid ||
        envStat.uid !== process.getuid!()
      )
        return fail();
      const expected = n3ObserverEnv(pinned, undefined, {});
      const local = readFileSync(envPath, "utf8").split("\n");
      if (!Array.isArray(info.Config?.Env) || info.Config.Env.length > 4096) return fail();
      const configured = info.Config.Env as unknown[];
      if (!configured.every((v) => typeof v === "string") || configured.join("\n").length > 65536)
        return fail();
      for (const value of expected) {
        const key = value.slice(0, value.indexOf("=") + 1);
        if (
          local.filter((v) => v.startsWith(key)).join() !== value ||
          configured.filter((v) => typeof v === "string" && v.startsWith(key)).join() !== value
        )
          return fail();
      }
      if (!Array.isArray(info.Mounts)) return fail();
      for (const [name, destination] of [
        ["jarv1s-cli-auth", "/data/cli-auth"],
        ["jarv1s-cli-socket", "/run/jarv1s"]
      ]) {
        const matches = info.Mounts.filter((m) => m && m.Destination === destination);
        if (
          matches.length !== 1 ||
          matches[0].Type !== "volume" ||
          matches[0].Name !== `${projectName}_${name}`
        )
          return fail();
      }
      const bootstrap = copiedFile(
        await invoke("docker", ["cp", `${id}:${N3_BOOTSTRAP_PATH}`, "-"]),
        65536
      );
      if (
        hash(bootstrap) !== pinned.bootstrapSha256 ||
        hash(readSource()) !== pinned.bootstrapSha256 ||
        (await invoke("git", ["rev-parse", "HEAD"])).toString().trim() !== commit
      )
        return fail();
      // The producer keeps source/image inventory authority; no second lifecycle receipt is emitted.
      const again = await inspect();
      const current = lstatSync(envPath);
      if (
        again.Id !== id ||
        again.Image !== info.Image ||
        again.State?.Status !== "created" ||
        current.ino !== envStat.ino ||
        current.dev !== envStat.dev ||
        hash(readFileSync(envPath)) !== hash(local.join("\n"))
      )
        return fail();
    }
  };
}

// Validation and metadata failures never echo raw child output, JSON input or filesystem errors.
export async function prepareN3Observer(
  ...args: Parameters<typeof prepareObserver>
): Promise<N3Prepared | undefined> {
  try {
    const prepared = await prepareObserver(...args);
    if (!prepared) return undefined;
    return {
      ...prepared,
      beforeInitialStart: async (input) => {
        try {
          await prepared.beforeInitialStart(input);
        } catch {
          return fail();
        }
      }
    };
  } catch {
    return fail();
  }
}
