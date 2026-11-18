/* global document */
import { esc, randomKey, transcriptTime } from "./format.mjs";
import { alertHint, btn, hint } from "./kit.mjs";
import {
  GAP_REASONS,
  captureAcknowledged,
  captureConnected,
  captureStopped,
  isDefinite,
  panelHint,
  recordedDuration,
  requestFailure,
  sourceReady,
  statusLabel
} from "./capture-logic.mjs";

const POLL_LIVE_MS = 1500;
const POLL_IDLE_MS = 5000;

/** The recording panel for one meeting. The record screen owns where it sits. */
export function capturePanel({ api, draw, meeting, heading, onLive, navigate }) {
  const s = {
    capture: null,
    processingReady: undefined,
    fetchedAt: Date.now(),
    status: "loading",
    prefs: null,
    devices: { phase: "loading", list: [], processingReady: undefined },
    op: null,
    error: null,
    gapsOpen: false
  };
  let poll = null;
  let tick = null;
  let alive = true;
  let shown = { grantId: null, duration: 0 };

  const live = () =>
    !!s.op ||
    (!!s.capture && !["idle", "revoked"].includes(s.capture.desired) && !captureStopped(s.capture));

  async function refresh() {
    try {
      const reply = await api.capture(meeting.id);
      s.capture = reply.capture ?? null;
      s.processingReady = reply.processingReady;
      s.fetchedAt = Date.now();
      s.status = "ready";
    } catch (error) {
      s.status =
        error?.status === 401 || error?.status === 403
          ? "denied"
          : error?.status === 404
            ? "notfound"
            : "failed";
    }
  }

  async function refreshAll() {
    const [, prefs, devices] = await Promise.allSettled([
      refresh(),
      api.preferences(),
      api.devices()
    ]);
    if (!alive) return;
    s.prefs = prefs.status === "fulfilled" ? prefs.value : s.prefs;
    s.devices =
      devices.status === "fulfilled"
        ? {
            phase: "ready",
            list: devices.value.devices ?? [],
            processingReady: devices.value.processingReady
          }
        : { phase: "failed", list: s.devices.list, processingReady: undefined };
    onLive(live());
    draw();
  }

  function schedule() {
    clearTimeout(poll);
    if (!alive) return;
    poll = setTimeout(
      async () => {
        await refreshAll();
        schedule();
      },
      live() ? POLL_LIVE_MS : POLL_IDLE_MS
    );
  }

  function serverNow() {
    return s.capture ? Date.parse(s.capture.serverTime) + (Date.now() - s.fetchedAt) : Date.now();
  }

  function clock() {
    const c = s.capture;
    if (!c) return 0;
    const connected = s.status === "ready" && captureConnected(c, serverNow());
    const value = recordedDuration(c, serverNow(), connected, shown);
    shown = { grantId: c.grantId, duration: value };
    return value;
  }

  function startTick() {
    clearInterval(tick);
    tick = setInterval(() => {
      const node = document.querySelector("[data-capture-clock]");
      if (node && s.capture) node.textContent = transcriptTime(clock());
    }, 1000);
  }

  async function send(request) {
    s.error = null;
    s.op = { request, phase: "sending" };
    onLive(true);
    draw();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (request.kind === "start")
          await api.captureStart(meeting.id, { requestKey: request.requestKey });
        else await api.captureControl(meeting.id, request.input);
        s.op = null;
        await refresh();
        onLive(live());
        draw();
        return;
      } catch (error) {
        if (!alive) return;
        if (error?.status === 409 && request.kind === "control" && attempt < 2) {
          // The capture moved on. Reload it and send the command against the new generation.
          await refresh();
          const c = s.capture;
          if (
            c &&
            c.grantId === request.input.grantId &&
            c.generation !== request.input.expectedGeneration
          ) {
            request = {
              kind: "control",
              input: { ...request.input, expectedGeneration: c.generation }
            };
            continue;
          }
        }
        s.error = requestFailure(error);
        s.op = isDefinite(error) ? null : { request, phase: "retry" };
        await refresh();
        onLive(live());
        draw();
        return;
      }
    }
  }

  async function stop() {
    const c = s.capture;
    if (c && !["stopped", "revoked"].includes(c.desired)) {
      await send({
        kind: "control",
        input: {
          grantId: c.grantId,
          command: "stop",
          expectedGeneration: c.generation,
          requestKey: randomKey()
        }
      });
    } else if (!c && s.op?.request.kind === "start") {
      const key = s.op.request.requestKey;
      try {
        await api.captureCancelStart(meeting.id, { requestKey: key });
        s.error = null;
      } catch {
        s.error = "No recording was confirmed. Check Trail Marker’s local Stop before closing it.";
      }
      s.op = null;
      await refresh();
      onLive(live());
      draw();
    }
  }

  const control = (command) => {
    const c = s.capture;
    if (!c) return;
    void send({
      kind: "control",
      input: {
        grantId: c.grantId,
        command,
        expectedGeneration: c.generation,
        requestKey: randomKey()
      }
    });
  };

  const acts = {
    "capture-start": () => void send({ kind: "start", requestKey: randomKey() }),
    "capture-pause": () => control("pause"),
    "capture-resume": () => control("record"),
    "capture-stop": () => void stop(),
    "capture-retry": () => s.op && void send(s.op.request),
    "capture-check": () => void refreshAll(),
    "capture-gaps": () => {
      s.gapsOpen = !s.gapsOpen;
      draw();
    },
    "capture-new": () => navigate("/meetings")
  };

  function view() {
    const c = s.capture;
    const linked = s.devices.list;
    const device = linked.length === 1 ? linked[0] : undefined;
    const connectedNow = !!c && s.status === "ready" && captureConnected(c, serverNow());
    const sourceOk = !!device && sourceReady(s.prefs, device.inventory);
    const processingOk = (s.devices.processingReady ?? s.processingReady) === true;
    const denied = s.status === "denied";
    const loading = s.status === "loading" || s.devices.phase === "loading" || !s.prefs;
    const ready =
      !denied &&
      !loading &&
      s.status === "ready" &&
      !!device &&
      sourceOk &&
      !device.busy &&
      processingOk;
    return { c, device, linked, connectedNow, sourceOk, denied, loading, ready };
  }

  function controls(v) {
    const c = v.c;
    const stopped = captureStopped(c);
    const revoked = c?.desired === "revoked";
    if ((!c || stopped || revoked) && !s.op)
      return stopped ? hint("Ended", ' style="margin:0"') : "";
    const label =
      s.status !== "ready"
        ? "Recording status unconfirmed"
        : c
          ? statusLabel(c, v.connectedNow)
          : "Starting…";
    const recording = c?.desired === "recording";
    const sending = s.op?.phase === "sending";
    const dot = `<span aria-label="${esc(label)}" title="${esc(label)}"><span class="jds-indicator jds-indicator--${recording ? "error" : "idle"}${v.connectedNow && c?.observed?.phase === "recording" ? " jds-indicator--live" : ""}"><span class="jds-indicator__dot"></span></span></span>`;
    return `<div class="jds-control-pill" role="group" aria-label="Recording controls">${dot}<span class="jds-label" aria-label="Recorded duration" data-capture-clock>${transcriptTime(clock())}</span>${
      recording ? btn("Pause", "capture-pause", { variant: "quiet", disabled: sending }) : ""
    }${
      c?.desired === "paused"
        ? btn("Resume", "capture-resume", {
            variant: "quiet",
            disabled:
              sending || !v.connectedNow || !captureAcknowledged(c) || s.processingReady === false
          })
        : ""
    }${!stopped && !revoked ? btn("Stop", "capture-stop", { variant: "quiet" }) : ""}</div>`;
  }

  function gaps(c) {
    if (!c || (!c.gaps?.length && !c.gapLimitReached)) return "";
    const n = c.gaps?.length ?? 0;
    const list = s.gapsOpen
      ? `<ul id="meeting-capture-gaps" class="meetings-section">${c.gaps
          .map(
            (g) =>
              `<li><span class="jds-label">${transcriptTime(g.startMs)}–${transcriptTime(g.endMs)}</span> <span class="jds-hint">${esc(GAP_REASONS[g.reason] ?? g.reason)}</span></li>`
          )
          .join("")}</ul>`
      : "";
    return `<div class="jds-note jds-note--practical"><div class="meetings-section"><p>${
      c.gapLimitReached
        ? "The capture gap limit was reached. Additional missing ranges may not be listed."
        : "Some audio is missing from this capture."
    }</p>${
      n
        ? `<button type="button" class="jds-disclosure" data-act="capture-gaps" aria-expanded="${s.gapsOpen}" aria-controls="meeting-capture-gaps">${s.gapsOpen ? "Hide" : "Show"} ${n} capture ${n === 1 ? "gap" : "gaps"}</button>${list}`
        : ""
    }</div></div>`;
  }

  function render() {
    const v = view();
    const c = v.c;
    const revoked = c?.desired === "revoked";
    const stopped = captureStopped(c);
    const message = panelHint({
      denied: v.denied,
      notFound: s.status === "notfound",
      statusFailed: s.status === "failed",
      revoked,
      capture: c,
      error: s.error,
      processingReady: s.devices.processingReady ?? s.processingReady,
      loading: v.loading,
      ready: v.ready,
      devicesFailed: s.devices.phase === "failed",
      ambiguous: v.linked.length > 1,
      device: v.device,
      sourceReady: v.sourceOk,
      linkedCount: v.linked.length
    });
    const badge =
      c && !revoked
        ? `<span class="jds-badge jds-badge--${c.desired === "recording" && v.connectedNow ? "red" : "neutral"}">${esc(statusLabel(c, v.connectedNow))}</span>`
        : !c && v.ready
          ? '<span class="jds-badge jds-badge--forest">Ready</span>'
          : "";
    const start =
      !c && !s.op ? btn("Start recording", "capture-start", { disabled: !v.ready }) : controls(v);
    const name = c?.deviceName ?? v.device?.deviceName;
    const link =
      !v.denied && (c || v.device)
        ? hint(
            `${esc(name)} · ${(c ? v.connectedNow : s.devices.phase !== "failed") ? "Connected" : "Disconnected"}`
          )
        : "";
    const action =
      s.op?.phase === "retry"
        ? btn("Try again", "capture-retry", { variant: "link" })
        : s.status === "failed" || s.devices.phase === "failed"
          ? btn("Check again", "capture-check", { variant: "link" })
          : "";
    const line = message
      ? message.startsWith("Recording access") || s.status === "failed"
        ? `<p role="alert" class="jds-hint jds-hint--error">${esc(message)} ${action}</p>`
        : `<p role="status" class="jds-hint">${esc(message)} ${action}</p>`
      : "";
    return `<section class="meetings-capture" aria-label="Meeting recording"><div class="meetings-actions meetings-capture-heading">${
      heading ? `<div class="meetings-capture-title">${heading}</div>` : ""
    }${badge}${start}</div>${link}${line}${gaps(c)}${
      stopped || revoked ? btn("New meeting", "capture-new", { variant: "link" }) : ""
    }</section>`;
  }

  return {
    render,
    acts,
    live,
    start() {
      alive = true;
      void refreshAll().then(schedule);
      startTick();
    },
    stop() {
      alive = false;
      clearTimeout(poll);
      clearInterval(tick);
    },
    alert: alertHint
  };
}
