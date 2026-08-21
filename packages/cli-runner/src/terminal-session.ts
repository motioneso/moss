// #1059 — a real PTY (node-pty) running a login shell for the owner terminal.
// Deliberately NOT tmux: a genuine PTY emits the raw escape-sequence byte stream
// xterm.js expects, sidestepping the pane-scraping that broke under claude 2.1.183.
// #1059: node-pty is loaded LAZILY (via createRequire), not as a top-level import.
// The api/worker bundles reach this module through the @moss/cli-runner barrel
// (for PROVIDER_CATALOG/LOGIN_ADAPTERS) but never construct a TerminalSession, so
// esbuild should tree-shake this class out entirely. But node-pty lives nested
// under packages/cli-runner/node_modules (pnpm layout) and is in esbuild's EXTERNAL
// list — a top-level `import * as pty from "node-pty"` survives as a side-effect
// import in dist/server.js and dist/worker.js regardless of tree-shaking, and throws
// ERR_MODULE_NOT_FOUND at container boot since that path isn't resolvable from /app.
// A type-only import has zero runtime footprint, so it's tree-shaken cleanly, and the
// real module is only require()'d inside the constructor when a PTY is actually spawned
// (cli-runner itself still runs as tsx source, unbundled, so this works there too).
import { createRequire } from "node:module";
// Type-only namespace import: erased at compile time (zero runtime footprint), so it
// never emits a `import "node-pty"` in the bundles. Using `typeof NodePty` for the
// require() cast below avoids an inline `import()` type annotation, which eslint's
// @typescript-eslint/consistent-type-imports rule forbids.
import type * as NodePty from "node-pty";
import { buildSanitizedCliEnv } from "./sanitized-env.js";

const require = createRequire(import.meta.url);

export interface TerminalSessionOptions {
  readonly id: string;
  readonly cols: number;
  readonly rows: number;
  readonly homeBase: string; // cwd + $HOME (cli-auth home) — landing dir, not a jail
  readonly toolsBinDir: string; // prepended to PATH so claude/codex/gemini resolve
}

export class TerminalSession {
  readonly id: string;
  private readonly term: NodePty.IPty;

  constructor(opts: TerminalSessionOptions) {
    this.id = opts.id;
    // #1059: lazy require, not a top-level import — see the comment above the imports.
    const pty = require("node-pty") as typeof NodePty;
    this.term = pty.spawn("/bin/bash", ["-l"], {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.homeBase,
      env: {
        ...buildSanitizedCliEnv(process.env), // #1059: allowlist-only — NEVER leak the runner server's RPC secret / AES master keys / DB creds / vault roots into the owner shell (Hard Invariant: secrets never escape)
        HOME: opts.homeBase,
        TERM: "xterm-256color",
        PATH: `${opts.toolsBinDir}:${process.env.PATH ?? "/usr/bin"}`
      },
      // #1059: without this, node-pty uses its default 'utf8' encoding and lossily
      // decodes the PTY's raw byte stream (invalid sequences become U+FFFD) before we
      // ever see it. That defeats the reason we chose a real PTY over tmux — xterm.js
      // needs the exact escape-sequence bytes, not a decoded-then-reencoded copy.
      encoding: null
    });
  }

  onData(cb: (chunk: Buffer) => void): void {
    // node-pty's onData is statically typed IEvent<string>, but with `encoding: null`
    // above it delivers a raw Buffer at runtime (#1059). Guard for both so we never
    // silently re-encode through a JS string and corrupt the byte stream.
    this.term.onData((d) => cb(Buffer.isBuffer(d) ? d : Buffer.from(d, "utf8")));
  }
  onExit(cb: (code: number) => void): void {
    this.term.onExit(({ exitCode }) => cb(exitCode));
  }
  write(data: Buffer): void {
    // IPty.write accepts a Buffer directly — passing it through avoids a lossy
    // utf8 round-trip of bytes the shell/terminal may not treat as text (#1059).
    this.term.write(data);
  }
  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }
  pause(): void {
    this.term.pause();
  }
  resume(): void {
    this.term.resume();
  }
  kill(): void {
    try {
      this.term.kill();
    } catch {
      /* already gone */
    }
  }
}
