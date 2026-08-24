import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, LoaderCircle, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

// #xterm.js ships a stylesheet, not JS — a static CSS import is side-effect-only and safe
// at module scope (unlike `new Terminal()`, which touches `document` and must never run
// outside a browser-side effect; see the guard on the mount effect below).
import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import { Button, Dialog } from "@moss/ui";
import type { AiProviderConfigDto } from "@moss/shared";

import {
  ApiError,
  getTerminalStatus,
  requestTerminalTicket,
  setTerminalPassword,
  terminalWsUrl
} from "../api/client";
import { queryKeys } from "../api/query-keys";
import { useFeedback } from "./settings-feedback";
import { readError } from "./settings-types";

/**
 * #1059 owner-gated CLI-provider terminal. A CLI-auth provider has no API key to
 * credential-test, so the settings pane's Test action opens this modal instead: a
 * password step-up (set once, then required every session) gates a live PTY session
 * to the provider's CLI, streamed over a WebSocket ticket (Task 7 server, Task 8
 * client helpers). Structured after `delete-account.tsx` — a self-contained modal
 * using the shared `jds-dialog*` CSS classes directly (no reusable <Modal>
 * component exists in this codebase).
 */

/** The three reachable phases, plus the ticket the "unlocked" phase carries. */
export type TerminalModalPhase =
  | { readonly kind: "set-password" }
  | { readonly kind: "locked" }
  | { readonly kind: "unlocked"; readonly ticket: string };

export type TerminalModalEvent =
  | { readonly type: "status"; readonly passwordSet: boolean }
  | { readonly type: "password-set" }
  | { readonly type: "ticket"; readonly ticket: string };

/**
 * Pure phase transition, exported so the no-DOM/no-effect state machine is directly
 * unit-testable (corrections §6.2): status -> set-password | locked; set-password ->
 * locked once a password is created; locked -> unlocked once a ticket is issued.
 */
export function nextTerminalModalPhase(
  _current: TerminalModalPhase | null,
  event: TerminalModalEvent
): TerminalModalPhase {
  switch (event.type) {
    case "status":
      return event.passwordSet ? { kind: "locked" } : { kind: "set-password" };
    case "password-set":
      return { kind: "locked" };
    case "ticket":
      return { kind: "unlocked", ticket: event.ticket };
  }
}

/**
 * The exact wire text-frame the server's resize handler expects (terminal-routes.ts
 * detects a resize instruction by JSON-parsing a non-binary frame — see corrections
 * §5). Exported so the shape is locked by a direct unit assertion, no DOM required.
 */
export function buildResizeMessage(cols: number, rows: number): string {
  return JSON.stringify({ type: "resize", cols, rows });
}

export function TerminalModal(props: {
  readonly provider: AiProviderConfigDto;
  readonly onClose: () => void;
}) {
  const { provider, onClose } = props;
  const { toast } = useFeedback();
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: queryKeys.ai.terminalStatus(provider.id),
    queryFn: getTerminalStatus,
    retry: false
  });

  // Local override advances the phase past whatever the status query resolved, once the
  // user completes the set-password or unlock step. `null` defers entirely to the query.
  const [override, setOverride] = useState<TerminalModalPhase | null>(null);
  const phase: TerminalModalPhase | null =
    override ??
    (statusQuery.data
      ? nextTerminalModalPhase(null, { type: "status", passwordSet: statusQuery.data.passwordSet })
      : null);

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [hasTerminalSelection, setHasTerminalSelection] = useState(false);

  const setPasswordMutation = useMutation({
    mutationFn: (pw: string) => setTerminalPassword(pw),
    onSuccess: () => {
      queryClient.setQueryData(queryKeys.ai.terminalStatus(provider.id), { passwordSet: true });
      setPassword("");
      setConfirmPassword("");
      setOverride(nextTerminalModalPhase(phase, { type: "password-set" }));
    },
    onError: (error) =>
      toast(readError(error), { tone: "drift", icon: <TriangleAlert size={17} /> })
  });

  const ticketMutation = useMutation({
    mutationFn: (pw: string) => requestTerminalTicket(pw),
    onSuccess: ({ ticket }) => {
      setPassword("");
      setOverride(nextTerminalModalPhase(phase, { type: "ticket", ticket }));
    },
    onError: (error) => {
      const message =
        error instanceof ApiError && error.status === 401 ? "Incorrect password" : readError(error);
      toast(message, { tone: "drift", icon: <TriangleAlert size={17} /> });
    }
  });

  // Terminal is currently connecting or streaming — the click-outside-to-close scrim
  // guard mirrors delete-account.tsx's `!deleteMutation.isPending` guard: don't drop a
  // live PTY session because of a stray click on the backdrop.
  const isLive = phase?.kind === "unlocked";

  const termHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const ticket = phase?.kind === "unlocked" ? phase.ticket : null;

  useEffect(() => {
    // Guarded on the unlocked phase AND a mounted ref: `new Terminal()` / `term.open()`
    // touch `document` immediately and must never run during a react-dom/server render
    // pass (this file's sibling components are rendered via renderToString in
    // tests/unit/) — only a browser-side effect after mount reaches this branch.
    if (!ticket || !termHostRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontSize: 13
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termHostRef.current);
    fitAddon.fit();
    terminalRef.current = term;
    const selectionDisposable = term.onSelectionChange(() => {
      setHasTerminalSelection(term.hasSelection());
    });

    const ws = new WebSocket(terminalWsUrl(ticket));
    ws.binaryType = "arraybuffer";

    // Server -> client: raw binary PTY bytes (terminal-routes.ts ~L225). Verified
    // matching the Task 7 server exactly — see corrections §5.
    ws.onmessage = (event) => {
      term.write(new Uint8Array(event.data as ArrayBuffer));
    };

    // Client -> server keystrokes: a binary frame per input chunk (server's isBinary
    // fallthrough writes it straight to the PTY).
    const dataDisposable = term.onData((chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(chunk));
      }
    });

    // Client -> server resize: a native TEXT frame (NOT TextEncoder-wrapped) — the
    // server distinguishes a resize instruction from a raw keystroke by checking
    // `isBinary === false` before attempting JSON.parse. Sending this as a binary
    // frame would defeat that check.
    const sendResize = () => {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buildResizeMessage(term.cols, term.rows));
      }
    };
    ws.onopen = sendResize;
    window.addEventListener("resize", sendResize);

    ws.onerror = () => {
      toast("Terminal connection failed", { tone: "drift", icon: <TriangleAlert size={17} /> });
    };

    // A server-side close (e.g. 1011 "terminal backend unavailable", 1008 "unauthorized") is a
    // clean close, not a socket error, so `onerror` above never fires for it — without this the
    // terminal was just left blank with no explanation at all. `1000` is a normal close from our
    // own cleanup below and should stay silent.
    ws.onclose = (event) => {
      if (event.code === 1000) return;
      term.writeln(`\r\n[connection closed: ${event.reason || `code ${event.code}`}]`);
      toast(event.reason || "Terminal connection closed", {
        tone: "drift",
        icon: <TriangleAlert size={17} />
      });
    };

    return () => {
      window.removeEventListener("resize", sendResize);
      dataDisposable.dispose();
      selectionDisposable.dispose();
      terminalRef.current = null;
      setHasTerminalSelection(false);
      ws.close();
      term.dispose();
    };
    // `toast` comes from useFeedback()'s stable context value; only the ticket identity
    // should re-run this effect (a new ticket means a fresh WS connection to open).
  }, [ticket]);

  const copyTerminalSelection = async () => {
    const selection = terminalRef.current?.getSelection();
    if (!selection) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(selection);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = selection;
        textarea.setAttribute("readonly", "true");
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        try {
          textarea.select();
          if (!document.execCommand("copy")) throw new Error("copy failed");
        } finally {
          textarea.remove();
        }
      }
      toast("Selected terminal text copied", { tone: "ready" });
    } catch {
      toast("Could not copy the selected terminal text", { tone: "drift" });
    }
  };

  const onSubmitSetPassword = (event: FormEvent) => {
    event.preventDefault();
    if (setPasswordMutation.isPending) return;
    if (!password || password !== confirmPassword) return;
    setPasswordMutation.mutate(password);
  };

  const onSubmitUnlock = (event: FormEvent) => {
    event.preventDefault();
    if (ticketMutation.isPending || !password) return;
    ticketMutation.mutate(password);
  };

  const titleId = useId();

  const body: ReactNode =
    phase === null ? (
      <LoaderCircle size={16} className="dexp__spin" aria-hidden="true" />
    ) : phase.kind === "set-password" ? (
      <>
        <div className="term-modal__prompt">Set a terminal password</div>
        <label className="deldlg__field">
          <span className="deldlg__label">New terminal password</span>
          <input
            className="jds-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            disabled={setPasswordMutation.isPending}
            aria-label="New terminal password"
          />
        </label>
        <label className="deldlg__field">
          <span className="deldlg__label">Confirm password</span>
          <input
            className="jds-input"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            disabled={setPasswordMutation.isPending}
            aria-label="Confirm terminal password"
          />
        </label>
      </>
    ) : phase.kind === "locked" ? (
      <>
        <div className="term-modal__prompt">Enter your terminal password</div>
        <label className="deldlg__field">
          <span className="deldlg__label">Terminal password</span>
          <input
            className="jds-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={ticketMutation.isPending}
            aria-label="Terminal password"
          />
        </label>
      </>
    ) : (
      <div className="term-modal__host" ref={termHostRef} />
    );

  const footer: ReactNode =
    phase === null ? null : phase.kind === "set-password" ? (
      <>
        <Button variant="quiet" onClick={onClose} disabled={setPasswordMutation.isPending}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={setPasswordMutation.isPending || !password || password !== confirmPassword}
        >
          {setPasswordMutation.isPending ? (
            <>
              <LoaderCircle size={15} className="dexp__spin" aria-hidden="true" />
              Setting…
            </>
          ) : (
            "Set password"
          )}
        </Button>
      </>
    ) : phase.kind === "locked" ? (
      <>
        <Button variant="quiet" onClick={onClose} disabled={ticketMutation.isPending}>
          Cancel
        </Button>
        <Button type="submit" disabled={ticketMutation.isPending || !password}>
          {ticketMutation.isPending ? (
            <>
              <LoaderCircle size={15} className="dexp__spin" aria-hidden="true" />
              Unlocking…
            </>
          ) : (
            <>
              <KeyRound size={15} aria-hidden="true" />
              Unlock
            </>
          )}
        </Button>
      </>
    ) : (
      <>
        <Button
          variant="quiet"
          onClick={() => void copyTerminalSelection()}
          disabled={!hasTerminalSelection}
        >
          <Copy size={14} aria-hidden="true" />
          Copy selected text
        </Button>
        <Button variant="quiet" onClick={onClose} icon={<X size={14} aria-hidden="true" />}>
          Close
        </Button>
      </>
    );

  const dialog = (
    <Dialog
      className="terminal-modal"
      onClose={() => {
        if (!isLive) onClose();
      }}
      aria-labelledby={titleId}
      title={<span id={titleId}>{provider.displayName} terminal</span>}
      description={
        phase?.kind === "unlocked"
          ? "Live session — this streams directly to the provider's CLI."
          : "A terminal password gates this live session (separate from your account password)."
      }
      footer={footer}
    >
      {body}
    </Dialog>
  );

  if (phase?.kind === "set-password") return <form onSubmit={onSubmitSetPassword}>{dialog}</form>;
  if (phase?.kind === "locked") return <form onSubmit={onSubmitUnlock}>{dialog}</form>;
  return dialog;
}
