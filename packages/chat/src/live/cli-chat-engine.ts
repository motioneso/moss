/**
 * CliChatEngineImpl — a persistent per-session CLI engine that drives a coding
 * CLI (`claude`, `codex`, or `gemini`) inside a long-lived multiplexer session
 * and exposes it via the CliChatEngine interface.
 *
 * The engine is multiplexer-neutral: session lifecycle (open/submit/isAlive/kill)
 * is delegated to an injected `Multiplexer` (tmux by default, herdr alternative),
 * and the engine stores the OPAQUE handle that `open()` returns. The engine keeps
 * owning file/transcript I/O via the shared `TmuxIo` seam from @moss/ai, so it
 * is unit-testable without a real tmux/herdr binary, a real CLI install, or
 * Postgres. With no `mux` opt it defaults to a TmuxMultiplexer over the same io,
 * reproducing the exact legacy tmux verb sequence.
 *
 * The Claude launch flags below are SECURITY-CRITICAL and were empirically
 * verified in the Phase 1 spike (docs/superpowers/spikes/2026-06-08-cli-capability-matrix.md):
 *   --permission-mode default       — #1071 (revert of #1068): the seeding (provider-first-run.ts)
 *                                     + correct HOME=/data/cli-auth already suppress claude 2.1.x's
 *                                     folder-trust wizard under `default`; `bypassPermissions` instead
 *                                     triggers a BLOCKING bypass-mode accept warning that the REPL
 *                                     can't answer → verified-submit fails → 503. Native-tool safety
 *                                     comes from --tools "" / the PreToolUse allowlist hook, NOT this
 *                                     flag (see buildClaudeCommand + claude-permission-hook).
 *   --tools ""                      — empty allowlist disables ALL native tools (F1: a
 *                                     denylist was bypassed via the Monitor tool)
 *   --append-system-prompt-file P   — inject persona (survives /clear; append, not replace)
 *   --session-id <uuid>             — pin the transcript filename, known before launch
 *   --strict-mcp-config             — do not load the operator's global MCP servers
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  captureAckCursor,
  hasExactUserAck,
  parseTranscript,
  transcriptGlobDir,
  TmuxMultiplexer,
  type Multiplexer,
  type MuxHandle,
  type AckCursor,
  type AckProviderKind,
  type ProviderKind,
  type TmuxIo
} from "@moss/ai";
import type { AiProviderExecutionMode } from "@moss/shared";

import { CliChatUnavailableError } from "./errors.js";
import { CodexExecSession } from "./codex-exec-session.js";
import { redactCause, sanitizeInput } from "./cli-engine-helpers.js";
import { composerHasExactEcho, isComposerEmpty } from "./composer-evidence.js";
import {
  VerifiedSubmitError,
  type CliChatEngineDiagnostic,
  type CliChatEngineOpts,
  type VerifiedSubmitOpts
} from "./cli-chat-engine-opts.js";
import { killMuxSessionByName, SESSION_PREFIX } from "./cli-session-lifecycle.js";
// #1170 file-cap split: launch-line builders + per-session secret/config writers
// moved verbatim to cli-launch-commands.ts (same pattern as the #1157 opts split).
import {
  buildLaunchCommand,
  resolvePersonaPath,
  writeCodexTokenEnv,
  writeGeminiSettings
} from "./cli-launch-commands.js";
import {
  codexTranscriptMatchesIdentity,
  codexTranscriptPath,
  parseCodexSessionUuid,
  persistCodexSessionIdentity,
  persistGeminiSessionIdentity,
  purgeCodexTranscript,
  purgeGeminiConversation,
  readCodexSessionIdentity,
  readGeminiSessionIdentity
} from "./private-transcript-cleanup.js";
import type {
  ChatRecordKind,
  CliChatEngine,
  EngineKillOpts,
  EngineLaunchOpts,
  TranscriptRecord
} from "./types.js";

export {
  LOGIN_SESSION_PREFIX,
  killLoginMuxSession,
  listLoginMuxSessions,
  listLoginMuxSessionsWithAge,
  type LoginMuxSessionAge
} from "./login-mux-sessions.js";
export { composerHasExactEcho, isComposerEmpty } from "./composer-evidence.js";
// Split out for the 1000-line file cap (#1157); re-exported to keep import paths stable.
export {
  VerifiedSubmitError,
  type CliChatEngineDiagnostic,
  type CliChatEngineOpts,
  type VerifiedSubmitOpts
} from "./cli-chat-engine-opts.js";
export {
  deriveNeutralDir,
  killMuxSessionByName,
  listLiveMuxSessions,
  removeNeutralDir,
  sanitizeSessionKey,
  SESSION_PREFIX
} from "./cli-session-lifecycle.js";
export {
  invalidateProviderProbeCache,
  probeProvider,
  type ProbeProviderResult,
  type ProbeProviderStatus
} from "./provider-probe.js";

/** Result of a bounded server-side replay-drain (§4.1.2). */
interface DrainOutcome {
  /** The transcript length consumed at the last safe boundary (jsonl.length / UTF-16). */
  readonly offset: number;
}

/**
 * A persistent CLI session driven through a Multiplexer. One instance per live
 * session. Supports anthropic (Claude Code), openai-compatible (Codex), and
 * google (Gemini).
 */
export class CliChatEngineImpl implements CliChatEngine {
  private readonly mux: Multiplexer;
  /** The opaque session handle returned by mux.open() at launch. */
  private handle: MuxHandle | null = null;

  private storedTranscriptPath: string | null = null;
  private transcriptDir: string | null = null;

  /** Exact per-session cwd used to validate provider transcript identity. */
  private neutralDir: string | null = null;

  /** Per-session Codex MCP token env file, removed on kill / failed launch. */
  private codexTokenEnvPath: string | null = null;

  /** Optional host-HOME base for transcript resolution (containerized bridge). */
  private readonly homeBase?: string;
  /** (#363) 0600 token file the claude launch reads CLAUDE_CODE_OAUTH_TOKEN from (claude-scoped). */
  private readonly credentialFile?: string;

  /** #342: whether this engine owns the server-side replay-drain (cli-runner path). */
  private readonly ownsDrain: boolean;
  private readonly drainMs: number;
  private readonly drainPollMs: number;
  private readonly echoMs: number;
  private readonly verifiedSubmitMs: number;
  private readonly nudgeAfterMs: number;
  private readonly muxCallMs: number;
  private readonly executionMode: AiProviderExecutionMode;
  private readonly onDiagnostic?: (event: CliChatEngineDiagnostic) => void;
  private codexExec: CodexExecSession | null = null;
  private codexExecLogicalAlive = false;
  private codexSessionUuid: string | null = null;
  private geminiSessionUuid: string | null = null;
  private geminiHasSubmitted = false;

  constructor(
    public readonly provider: ProviderKind,
    private readonly threadKey: string,
    private readonly io: TmuxIo,
    opts: CliChatEngineOpts = {}
  ) {
    this.mux = opts.mux ?? new TmuxMultiplexer(io, { homeBase: opts.homeBase });
    this.homeBase = opts.homeBase;
    this.credentialFile = opts.credentialFile;
    this.ownsDrain = opts.ownsDrain ?? false;
    this.drainMs = opts.drainMs ?? 25_000;
    this.drainPollMs = opts.drainPollMs ?? 250;
    this.echoMs = opts.echoMs ?? 10_000;
    this.verifiedSubmitMs = opts.verifiedSubmitMs ?? 35_000;
    this.nudgeAfterMs = opts.nudgeAfterMs ?? 7_000;
    this.muxCallMs = opts.muxCallMs ?? 10_000;
    // In production executionMode is always threaded in from the NOT NULL DB column
    // (persistence → factory → engine), so this fallback is defensive-only and never fires.
    // It stays "interactive" as the conservative full-session default for direct construction;
    // the one-shot-by-default flip lives at the DB + repository write-path layer (#1238/#1239,
    // migration 0172). See #1239 for why flipping it here buys nothing in prod.
    this.executionMode = opts.executionMode ?? "interactive";
    this.onDiagnostic = opts.onDiagnostic;
  }

  /** #1226 relay-5/6: bound a single mux RPC so a stalled call can't hang verifiedSubmit
   * forever. Throws a plain Error (never VerifiedSubmitError) — the caller's existing
   * entered/pasted classification in verifiedSubmit's catch block already turns any thrown
   * error into the correct unavailable/delivery_unknown code. */
  private async raceMux<T>(call: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`mux call did not settle within ${this.muxCallMs}ms`)),
        this.muxCallMs
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([call, timedOut]);
    } finally {
      clearTimeout(timer!);
    }
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
    // Generate the session id up front. For Claude this also pins the transcript
    // filename (`--session-id`), so no fragile newest-file globbing is needed there.
    // #2028 — the Gemini CLI takes the same flag, so Google gets the same treatment: the
    // conversation is named by an id we chose before it exists. Only Codex refuses our id, so it
    // alone still has to capture its provider identity before a private turn can proceed.
    const sessionId = randomUUID();
    this.neutralDir = opts.neutralDir;
    this.codexSessionUuid = null;
    this.geminiSessionUuid = this.provider === "google" ? sessionId : null;
    this.geminiHasSubmitted = false;

    // ── PRE-mux-create setup (persona + per-provider secret files) ──────────────
    // Any failure here is a PRE-mux-create failure: no mux session exists yet, so
    // removing the per-session neutral dir suffices (§6.5). The whole block is
    // guarded so a write failure tears down the dir before surfacing the error.
    let personaPath: string;
    try {
      // When the cli-runner owns the launch it ships persona CONTENT (`personaText`),
      // not a path: write it under the server-derived neutral dir, `0600` (§4.1.1a).
      // The in-process host path keeps using the manager-rendered `personaPath`.
      personaPath = await resolvePersonaPath(this.io, opts);

      this.codexTokenEnvPath =
        this.provider === "openai-compatible" ? await writeCodexTokenEnv(this.io, opts) : null;

      if (this.provider === "google" && opts.mcpToken && opts.mcpServerUrl) {
        await writeGeminiSettings(this.io, opts);
      }
    } catch (err) {
      // PRE-mux-create failure: remove the whole per-session neutral dir (§6.5).
      await this.removeNeutralDirQuietly();
      throw new CliChatUnavailableError("could not start the live chat session", {
        cause: redactCause(err)
      });
    }

    this.transcriptDir = transcriptGlobDir(this.provider, opts.neutralDir, this.homeBase);
    // Claude's `--session-id` pins its filename immediately. Codex is pinned after exact
    // `/status` capture; the legacy Google reader remains lazy and is out of #868 scope.
    this.storedTranscriptPath =
      this.provider === "anthropic" ? join(this.transcriptDir, `${sessionId}.jsonl`) : null;

    if (this.isCodexExecMode()) {
      this.storedTranscriptPath = join(opts.neutralDir, "codex-exec-transcript.jsonl");
      this.codexExec = new CodexExecSession({
        io: this.io,
        launchOpts: opts,
        transcriptPath: this.storedTranscriptPath,
        tokenEnvPath: this.codexTokenEnvPath,
        ownsDrain: this.ownsDrain
      });
      await this.codexExec.initialize();
      this.codexExecLogicalAlive = true;
      return { offset: 0 };
    }

    const launchLine = await buildLaunchCommand(
      {
        provider: this.provider,
        io: this.io,
        executionMode: this.executionMode,
        credentialFile: this.credentialFile,
        codexTokenEnvPath: this.codexTokenEnvPath
      },
      opts,
      sessionId,
      personaPath
    );
    try {
      this.handle = await this.mux.open({
        name: `${SESSION_PREFIX}${this.threadKey}`,
        cols: 220,
        rows: 50,
        launchLine
      });
    } catch (err) {
      // PRE-mux-create failure (the mux.open itself failed and tore down any
      // half-created session): remove the entire per-session neutral dir (§6.5).
      // This drops every per-provider secret file (Claude/Codex/Gemini) + persona.
      await this.removeNeutralDirQuietly();
      // A backend exit-code failure (missing binary via JARVIS_MULTIPLEXER override,
      // herdr socket failure, unresolvable root pane, tmux new-session failure) throws
      // a plain Error from mux.open(). Convert it to the 503-mapped error with a
      // sanitized message; the raw cause is logged server-side by the route handler
      // (Codex R2 #2). Never surface raw stderr to the client.
      //
      // Defense-in-depth: a custom multiplexer can still echo token-shaped stderr.
      // Redact at this boundary so no token shape can reach a log via the
      // structurally-serialized `cause`.
      throw new CliChatUnavailableError("could not start the live chat session", {
        cause: redactCause(err)
      });
    }

    // ── POST-mux-create: (server-owned) replay-drain ───────────────────────────
    // From here `jarv1s-live-<threadKey>` EXISTS. Any failure is a POST-mux-create
    // failure: per §6.5 we MUST kill the mux session by canonical name BEFORE
    // removing the dir, else the orphan lingers in listLiveSessions-by-mux and
    // blocks the §4.1.0a single-active-user gate for everyone.
    try {
      await this.ensurePurgeableIdentityAtLaunch(this.handle);
      if (!this.ownsDrain) {
        // In-process host path: the manager owns the replay-drain (§4.1.2). Return
        // offset 0 so it keeps overwriting `transcriptOffset` from its own drain.
        return { offset: 0 };
      }

      // cli-runner path: submit the replay batch (if any) and drain to a clean
      // boundary, returning the post-drain offset (§4.1.2).
      const drained = await this.replayAndDrain(opts.replayBatch, opts.replayAttemptId);
      return { offset: drained.offset };
    } catch (err) {
      await this.purgeThenKillQuietly();
      throw new CliChatUnavailableError("could not start the live chat session", {
        cause: redactCause(err)
      });
    }
  }

  async submit(text: string): Promise<void> {
    const sanitized = sanitizeInput(text);
    if (this.isCodexExecMode()) {
      if (!this.codexExec) throw new Error("CliChatEngineImpl.submit called before launch()");
      await this.codexExec.submit(sanitized);
      return;
    }
    // #1157: mux delivery failure (pane gone — engine died out-of-band) = text verifiably
    // never entered the engine. Classify as CliChatUnavailableError so runTurn's heal branch
    // can relaunch + resubmit once; a plain Error would bypass it. RPC path already gets
    // this typing from cli-runner (VerifiedSubmitError) — this is in-process parity.
    try {
      await this.mux.submit(this.requireHandle(), sanitized);
    } catch (err) {
      throw new CliChatUnavailableError("live chat engine terminal is gone", {
        cause: redactCause(err)
      });
    }
    if (this.provider === "google") this.geminiHasSubmitted = true;
  }

  async verifiedSubmit(opts: VerifiedSubmitOpts): Promise<void> {
    const sanitized = sanitizeInput(opts.text);
    if (this.isCodexExecMode()) {
      if (!this.codexExec)
        throw new Error("CliChatEngineImpl.verifiedSubmit called before launch()");
      await this.codexExec.submit(sanitized);
      return;
    }
    if (this.provider === "google") {
      throw new VerifiedSubmitError("unavailable");
    }

    const handle = this.requireHandle();
    let pasted = false;
    let entered = false;
    try {
      await this.ensureCodexSessionIdentity(handle, opts.signal);
      const ack = await this.captureUserAckCursor(opts.signal);
      this.throwIfCanceled(opts.signal);

      for (let pasteAttempt = 0; pasteAttempt < 2; pasteAttempt += 1) {
        // #1157: before wiping the composer, check whether a PREVIOUS turn's text is still
        // sitting in it (pasted but never submitted — the prod "stuck 'try again'" failure).
        // clearComposer below destroys that evidence, so this is the only place the loss is
        // observable. Report a char count only (never content) and never let the probe itself
        // break the submit path.
        if (pasteAttempt === 0 && this.onDiagnostic) {
          try {
            const preClearPane = await this.raceMux(this.mux.capturePane(handle));
            if (!isComposerEmpty(this.provider, preClearPane)) {
              this.onDiagnostic({
                kind: "composer_discarded",
                paneChars: preClearPane.trim().length
              });
            }
          } catch {
            // Diagnostic is best-effort; a capture failure must not block the turn.
          }
        }
        await this.raceMux(this.mux.clearComposer(handle));
        this.throwIfCanceled(opts.signal);
        let empty = await this.observePane(
          handle,
          (pane) => isComposerEmpty(this.provider, pane),
          opts.signal
        );
        if (!empty) {
          // #1170: clearComposer (C-u) only clears the CURRENT composer line — a stuck
          // MULTILINE composer (e.g. a previous attachment turn's failed paste) survives
          // it, so without this fallback the emptiness gate fails on every later turn of
          // the session ("chat input unavailable" forever). Ctrl+C wipes the whole
          // composer in one press (probed live, claude 2.1.215). Only sent here, after
          // observing non-empty: Ctrl+C on an EMPTY composer arms the CLI's
          // press-again-to-exit state and a second press would kill the session.
          await this.raceMux(this.mux.clearComposerHard(handle));
          this.throwIfCanceled(opts.signal);
          empty = await this.observePane(
            handle,
            (pane) => isComposerEmpty(this.provider, pane),
            opts.signal
          );
        }
        if (!empty) throw new VerifiedSubmitError("unavailable");
        pasted = false;

        pasted = true;
        await this.raceMux(this.mux.paste(handle, sanitized));
        this.throwIfCanceled(opts.signal);
        const echoed = await this.observePane(
          handle,
          (pane) => composerHasExactEcho(this.provider, pane, sanitized),
          opts.signal
        );
        if (!echoed) continue;

        entered = true;
        await this.raceMux(this.mux.pressEnter(handle));
        this.throwIfCanceled(opts.signal);
        await this.waitForUserAckWithEnterNudge(ack, sanitized, handle, opts.signal);
        return;
      }
      throw new VerifiedSubmitError("unavailable");
    } catch (err) {
      if (entered) {
        await this.purgeThenKillQuietly();
        throw new VerifiedSubmitError("delivery_unknown", true);
      }
      if (pasted) {
        const cleared = await this.clearPastedComposer(handle);
        if (!cleared) {
          await this.purgeThenKillQuietly();
          throw new VerifiedSubmitError("unavailable", true);
        }
      }
      if (err instanceof VerifiedSubmitError) throw err;
      throw new VerifiedSubmitError("unavailable");
    }
  }

  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    if (this.transcriptDir === null) {
      throw new Error("CliChatEngineImpl.readNew called before launch()");
    }

    const path = await this.resolveTranscriptPath();
    if (path === null) {
      // Provider transcript not created yet — keep the caller's offset.
      return { records: [], offset: afterOffset, complete: false };
    }

    let jsonl: string;
    try {
      jsonl = await this.io.readFile(path);
    } catch {
      // Transcript not created yet — tolerate, return empty/not-complete and
      // keep the caller's offset so nothing is skipped.
      return { records: [], offset: afterOffset, complete: false };
    }

    const parsed = parseTranscript(this.provider, jsonl, afterOffset);

    const records: TranscriptRecord[] = parsed.events.map((e) => ({
      kind: e.kind as ChatRecordKind,
      text: e.text
    }));
    if (parsed.complete && parsed.reply !== null) {
      records.push({ kind: "reply", text: parsed.reply });
    }

    return { records, offset: jsonl.length, complete: parsed.complete };
  }

  async isAlive(): Promise<boolean> {
    if (this.isCodexExecMode()) return this.codexExecLogicalAlive;
    if (this.handle === null) return false;
    return this.mux.isAlive(this.handle);
  }

  async interrupt(): Promise<void> {
    if (this.handle !== null) await this.mux.interrupt(this.handle);
  }

  async kill(opts?: EngineKillOpts): Promise<void> {
    try {
      if (this.handle !== null) {
        await this.raceMux(this.mux.kill(this.handle));
      } else {
        // No engine-stored handle (e.g. a relaunch raced a restart): still kill by
        // the canonical mux name so a live `jarv1s-live-<key>` session can't survive
        // a kill (§4.5). Idempotent — killing an absent session is not an error.
        await killMuxSessionByName(this.io, this.threadKey, this.homeBase);
      }
    } finally {
      this.handle = null;
      // §6.5: remove the ENTIRE per-session neutral dir on kill (covers Claude's
      // .jarvis-claude-mcp.json, Codex's .jarvis-mcp-token.env, Gemini's
      // .gemini/settings.json, AND the persona file) — not just one file.
      this.codexTokenEnvPath = null;
      this.codexExec = null;
      this.codexExecLogicalAlive = false;
      if (!opts?.preserveNeutralDir) await this.removeNeutralDirQuietly();
    }
  }

  async purgeTranscripts(): Promise<void> {
    if (this.provider === "anthropic") {
      if (this.transcriptDir !== null) {
        const removed = await this.io.run("rm", ["-rf", this.transcriptDir]);
        if (removed.code !== 0) throw new Error("Could not purge Claude transcript");
      }
      return;
    }

    if (this.provider === "google") {
      // #2028 — the Gemini CLI names its own state directories by a short id derived from the
      // session folder, not by our session UUID, so the purge is keyed on the folder. The UUID is
      // still required here: its absence means launch never got far enough to write the marker,
      // and if a turn was nonetheless submitted that is a purge we cannot prove, so it fails loud.
      const uuid =
        this.geminiSessionUuid ??
        (this.neutralDir ? await readGeminiSessionIdentity(this.io, this.neutralDir) : null);
      if (uuid === null) {
        if (this.geminiHasSubmitted)
          throw new Error("Gemini session identity unavailable for purge");
        return;
      }
      if (this.neutralDir === null) return;
      if (!(await purgeGeminiConversation(this.io, this.neutralDir, this.homeBase))) {
        throw new Error("Could not purge Gemini conversation transcript");
      }
      return;
    }

    const uuid =
      this.codexSessionUuid ??
      (this.neutralDir ? await readCodexSessionIdentity(this.io, this.neutralDir) : null);
    if (uuid === null || this.neutralDir === null) return;
    if (!(await purgeCodexTranscript(this.io, this.neutralDir, uuid, this.homeBase)))
      throw new Error("Codex transcript identity mismatch");
  }

  // ─── introspection (used by tests / callers needing the pinned path) ─────────

  /**
   * The transcript path. For `anthropic` it is the session-id-pinned path computed
   * at launch. For `openai-compatible`/`google` the filename is chosen by the CLI,
   * so this returns the most-recently-resolved path (or throws if not yet resolved —
   * call after at least one readNew(), or use readNew() directly).
   */
  transcriptPath(): string {
    if (this.transcriptDir === null) {
      throw new Error("CliChatEngineImpl.transcriptPath called before launch()");
    }
    if (this.storedTranscriptPath === null) {
      throw new Error(
        "CliChatEngineImpl.transcriptPath: transcript not yet resolved for this provider (no .jsonl file written yet)"
      );
    }
    return this.storedTranscriptPath;
  }

  /**
   * Resolve the path of the transcript file to read.
   *
   * - `anthropic`: pinned at launch (deterministic via `--session-id`).
   * - `openai-compatible`: derive one rollout from its captured UUID and require UUID + cwd.
   * - `google`: legacy dead reader, retained out of #868 scope.
   */
  private async resolveTranscriptPath(signal?: AbortSignal): Promise<string | null> {
    this.throwIfCanceled(signal);
    if (this.storedTranscriptPath !== null) return this.storedTranscriptPath;
    if (this.transcriptDir === null) return null;

    if (
      this.provider === "openai-compatible" &&
      this.codexSessionUuid !== null &&
      this.neutralDir !== null
    ) {
      const path = codexTranscriptPath(this.codexSessionUuid, this.homeBase);
      try {
        const jsonl = await this.io.readFile(path);
        this.throwIfCanceled(signal);
        if (!codexTranscriptMatchesIdentity(jsonl, this.codexSessionUuid, this.neutralDir))
          return null;
        this.storedTranscriptPath = path;
        return path;
      } catch {
        this.throwIfCanceled(signal);
        return null;
      }
    }

    // Missing Codex identity is never authority to fall back to a newest/cwd heuristic.
    if (this.provider === "openai-compatible") return null;

    // #2028 — only the long-lived multiplexer path reaches here for Google, and its directory
    // name is a guess (see transcriptGlobDir). The one-shot engine Google chat actually runs
    // reads the reply from the process output instead and never calls this.
    const listed = await this.io.run("ls", ["-t", this.transcriptDir]);
    this.throwIfCanceled(signal);
    if (listed.code !== 0) return null;
    const candidates = listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name.endsWith(".jsonl"));

    const newest = candidates[0];
    if (!newest) return null;

    this.storedTranscriptPath = join(this.transcriptDir, newest);
    return this.storedTranscriptPath;
  }

  private requireHandle(): MuxHandle {
    if (this.handle === null) {
      throw new Error("CliChatEngineImpl.submit called before launch()");
    }
    return this.handle;
  }

  private async ensurePurgeableIdentityAtLaunch(handle: MuxHandle): Promise<void> {
    if (this.provider === "openai-compatible") {
      await this.ensureCodexSessionIdentity(handle, new AbortController().signal);
      return;
    }
    if (this.provider !== "google" || this.neutralDir === null) return;

    // #2028 — nothing to scrape out of a pane any more: the launch line already opened the
    // conversation under `this.geminiSessionUuid`. Wait for the CLI to be ready, then write the
    // marker so a crash mid-turn still leaves the boot sweep a pointer to this session's state.
    const ready = await this.observePane(
      handle,
      (pane) => isComposerEmpty(this.provider, pane),
      new AbortController().signal
    );
    if (!ready) throw new VerifiedSubmitError("unavailable");
    if (this.geminiSessionUuid === null) throw new VerifiedSubmitError("unavailable");
    await persistGeminiSessionIdentity(this.io, this.neutralDir, this.geminiSessionUuid);
  }

  private async ensureCodexSessionIdentity(handle: MuxHandle, signal: AbortSignal): Promise<void> {
    if (this.provider !== "openai-compatible" || this.codexSessionUuid !== null) return;
    if (this.neutralDir === null) throw new VerifiedSubmitError("unavailable");

    let entered = false;
    try {
      await this.raceMux(this.mux.clearComposer(handle));
      this.throwIfCanceled(signal);
      const empty = await this.observePane(
        handle,
        (pane) => isComposerEmpty(this.provider, pane),
        signal
      );
      if (!empty) throw new VerifiedSubmitError("unavailable");

      await this.raceMux(this.mux.paste(handle, "/status"));
      this.throwIfCanceled(signal);
      const echoed = await this.observePane(
        handle,
        (pane) => composerHasExactEcho(this.provider, pane, "/status"),
        signal
      );
      if (!echoed) throw new VerifiedSubmitError("unavailable");

      entered = true;
      await this.raceMux(this.mux.pressEnter(handle));
      this.throwIfCanceled(signal);
      let uuid: string | null = null;
      const observed = await this.observePane(
        handle,
        (pane) => {
          uuid = parseCodexSessionUuid(pane);
          return uuid !== null;
        },
        signal
      );
      if (!observed || uuid === null) throw new VerifiedSubmitError("unavailable");
      await persistCodexSessionIdentity(this.io, this.neutralDir, uuid);
      this.throwIfCanceled(signal);
      this.codexSessionUuid = uuid;
    } catch {
      if (entered) {
        await this.purgeThenKillQuietly();
        throw new VerifiedSubmitError("unavailable", true);
      }
      const cleared = await this.clearPastedComposer(handle);
      if (!cleared) {
        await this.purgeThenKillQuietly();
        throw new VerifiedSubmitError("unavailable", true);
      }
      throw new VerifiedSubmitError("unavailable");
    }
  }

  private async captureUserAckCursor(signal?: AbortSignal): Promise<{
    readonly path: string | null;
    readonly cursor: AckCursor;
  }> {
    this.throwIfCanceled(signal);
    const path = await this.resolveTranscriptPath(signal);
    this.throwIfCanceled(signal);
    if (path === null) return { path: null, cursor: captureAckCursor("") };
    try {
      const jsonl = await this.io.readFile(path);
      this.throwIfCanceled(signal);
      return { path, cursor: captureAckCursor(jsonl) };
    } catch {
      this.throwIfCanceled(signal);
      return { path, cursor: captureAckCursor("") };
    }
  }

  /**
   * #1162/#1171: claude occasionally SWALLOWS the Enter keypress — the echo was verified,
   * Enter was sent, but the composer still holds the text and no user record ever reaches
   * the transcript (Ben's prod "stuck 'try again'" turns). Bounded recovery: wait a short
   * window for the transcript ack; if it doesn't land AND the composer still visibly holds
   * content, press Enter again (max 2 nudges). The composer-still-holds-content guard is
   * what makes re-pressing safe: an EMPTY composer means the text was submitted and the
   * ack is merely lagging, so we never re-press there — no duplicate-turn risk.
   */
  private async waitForUserAckWithEnterNudge(
    initial: { readonly path: string | null; readonly cursor: AckCursor },
    expectedText: string,
    handle: MuxHandle,
    signal: AbortSignal
  ): Promise<void> {
    const MAX_ENTER_NUDGES = 2;
    let composerEmptied = false;
    for (let nudge = 0; nudge < MAX_ENTER_NUDGES; nudge += 1) {
      if (await this.waitForUserAck(initial, expectedText, signal, this.nudgeAfterMs)) return;
      const pane = await this.raceMux(this.mux.capturePane(handle));
      this.throwIfCanceled(signal);
      if (isComposerEmpty(this.provider, pane)) {
        composerEmptied = true;
        break;
      }
      await this.raceMux(this.mux.pressEnter(handle));
      this.throwIfCanceled(signal);
    }
    if (!composerEmptied) {
      // #1226: initial Enter plus both bounded nudges left the composer still holding the
      // text — Enter is not landing, so no ack will ever arrive. Waiting further just delays
      // the inevitable; fail fast so the caller's entered=true catch classifies this as
      // delivery_unknown (kill once, never auto-resend) instead of spinning unbounded.
      throw new VerifiedSubmitError("delivery_unknown", true);
    }
    // Composer went empty: the text was submitted and the ack is merely lagging behind the
    // transcript writer, so this extended wait is a safe, non-duplicating poll. The prod RPC
    // still bounds it externally via its verified-submit deadline.
    await this.waitForUserAck(initial, expectedText, signal);
  }

  private async waitForUserAck(
    initial: { readonly path: string | null; readonly cursor: AckCursor },
    expectedText: string,
    signal: AbortSignal,
    deadlineMs?: number
  ): Promise<boolean> {
    const provider = this.provider as AckProviderKind;
    // deadlineMs bounds the wait for the Enter-nudge probe loop; without it the wait is
    // unbounded (pre-#1171 behavior) and only ever exits by acking or throwing on cancel.
    const deadline = deadlineMs === undefined ? null : Date.now() + deadlineMs;
    for (;;) {
      this.throwIfCanceled(signal);
      const path = initial.path ?? (await this.resolveTranscriptPath(signal));
      this.throwIfCanceled(signal);
      if (path !== null) {
        try {
          const jsonl = await this.io.readFile(path);
          this.throwIfCanceled(signal);
          if (hasExactUserAck(provider, jsonl, initial.cursor, expectedText)) return true;
        } catch {
          this.throwIfCanceled(signal);
        }
      }
      if (deadline !== null && Date.now() >= deadline) return false;
      await this.io.sleep(this.drainPollMs);
      this.throwIfCanceled(signal);
    }
  }

  private async observePane(
    handle: MuxHandle,
    predicate: (pane: string) => boolean,
    signal: AbortSignal
  ): Promise<boolean> {
    const deadline = Date.now() + this.echoMs;
    for (;;) {
      this.throwIfCanceled(signal);
      const pane = await this.raceMux(this.mux.capturePane(handle));
      this.throwIfCanceled(signal);
      if (predicate(pane)) return true;
      if (Date.now() >= deadline) return false;
      await this.io.sleep(this.drainPollMs);
    }
  }

  private async clearPastedComposer(handle: MuxHandle): Promise<boolean> {
    try {
      await this.raceMux(this.mux.clearComposer(handle));
      if (isComposerEmpty(this.provider, await this.raceMux(this.mux.capturePane(handle))))
        return true;
      // #1170: the pasted text we're discarding is usually MULTILINE (attachment manifests
      // always are), and C-u cannot empty a multiline composer — hard-clear (Ctrl+C) before
      // giving up, else the caller needlessly kills the whole session.
      await this.raceMux(this.mux.clearComposerHard(handle));
      return isComposerEmpty(this.provider, await this.raceMux(this.mux.capturePane(handle)));
    } catch {
      return false;
    }
  }

  private throwIfCanceled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new VerifiedSubmitError("unavailable");
  }

  private isCodexExecMode(): boolean {
    return this.provider === "openai-compatible" && this.executionMode === "non_interactive";
  }

  // ─── helpers ─────────────────────────────────────────────────────────────────

  /**
   * Bounded server-side replay-drain (§4.1.2). Submits `replayBatch` (if present)
   * then polls the transcript until the provider signals end-of-turn. Missing completion fails
   * launch; elapsed time is never readiness evidence.
   */
  private async replayAndDrain(
    replayBatch: string | undefined,
    replayAttemptId: string | undefined
  ): Promise<DrainOutcome> {
    if (!replayBatch) {
      // Fresh conversation: nothing to replay; the first real readNew starts at 0.
      return { offset: 0 };
    }

    if (this.provider === "google") {
      // #2028 — the long-lived Google path replays with a plain submit rather than a verified
      // one: verification reads the pane, and this path's transcript location is a guess. Google
      // chat runs one-shot in practice, so this branch is kept honest rather than proven.
      await this.submit(replayBatch);
    } else {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.verifiedSubmitMs);
      timer.unref?.();
      try {
        await this.verifiedSubmit({
          attemptId: replayAttemptId ?? randomUUID(),
          text: replayBatch,
          signal: controller.signal
        });
      } finally {
        clearTimeout(timer);
      }
    }

    const deadline = Date.now() + this.drainMs;
    let offset = 0;
    while (Date.now() < deadline) {
      let result: { records: TranscriptRecord[]; offset: number; complete: boolean };
      try {
        result = await this.readNew(offset);
      } catch {
        // Transcript not yet created / transient read miss — keep polling.
        await this.io.sleep(this.drainPollMs);
        continue;
      }
      offset = result.offset;
      if (result.complete) return { offset };
      await this.io.sleep(this.drainPollMs);
    }
    throw new Error("replay completion unavailable");
  }

  /** §6.5: remove the ENTIRE per-session neutral dir; best-effort, never throws. */
  private async removeNeutralDirQuietly(): Promise<void> {
    const dir = this.neutralDir;
    if (!dir) return;
    try {
      await this.io.run("rm", ["-rf", dir]);
    } catch {
      // best-effort cleanup — never mask the original failure.
    }
  }

  private async purgeThenKillQuietly(): Promise<void> {
    let purged = false;
    try {
      await this.purgeTranscripts();
      purged = true;
    } catch {
      // Keep original marker for engine-less retry.
    }
    try {
      await this.kill(purged ? undefined : { preserveNeutralDir: true });
    } catch {
      // Best-effort invalidation; kill() still applies its neutral-dir gate in finally.
    }
  }
}
