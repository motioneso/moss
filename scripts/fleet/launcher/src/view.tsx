import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { askJudge, acceptRescue, logLane, messageAgent, setLane } from "./operations.js";
import { loadState, logsForLane, spawnsSince, writeSettings } from "./state.js";
import type { Lane, LoadResult, Settings } from "./types.js";

const STATUS_LABELS: Record<string, string> = {
  queued: "waiting to start",
  building: "building",
  "pr-open": "waiting on checks",
  "ci-red": "checks failing",
  qa: "in review",
  "qa-red": "review found problems",
  "qa-green": "review passed",
  merging: "merging",
  blocked: "waiting on you",
  done: "done"
};

type Tab = "In Progress" | "Ready" | "Done Tonight";
const TABS: Tab[] = ["In Progress", "Ready", "Done Tonight"];

export function tabLanes(state: LoadResult, tab: Tab): Lane[] {
  if (tab === "Ready") return state.lanes.filter((lane) => lane.status === "queued");
  if (tab === "Done Tonight") {
    const cutoff = state.runStarted ? Date.parse(state.runStarted) : Number.POSITIVE_INFINITY;
    return state.lanes.filter(
      (lane) => lane.status === "done" && Date.parse(lane.updated_at || "") >= cutoff
    );
  }
  return state.lanes.filter((lane) => lane.status !== "queued" && lane.status !== "done");
}

function laneTitle(lane: Lane): string {
  return lane.title?.trim() || lane.spec?.split("/").pop() || `Issue #${lane.issue}`;
}

function story(lane: Lane, state: LoadResult): string {
  const logs = logsForLane(state.logs, lane.issue)
    .map((entry) => `${entry.ts || "?"} ${entry.msg || ""}`)
    .join("\n");
  return [
    `Issue #${lane.issue}: ${laneTitle(lane)}`,
    `Status: ${STATUS_LABELS[lane.status || ""] || lane.status || "unknown"}`,
    `Working for: ${age(lane.updated_at)}`,
    `Pull request: ${lane.pr ? `#${lane.pr}` : "none"}`,
    lane.failedCheck ? `Failed check: ${lane.failedCheck}` : "",
    lane.checks?.length
      ? `Checks: ${lane.checks.map((check) => `${check.name || "check"} (${check.state || "unknown"})`).join(", ")}`
      : "",
    `Relays: ${lane.relays || 0}; review rounds: ${lane.qa_rounds || 0}`,
    lane.question ? `Question: ${lane.question}` : "No outstanding question.",
    logs ? `Recent log:\n${logs}` : "No log entries yet."
  ].join("\n");
}

function age(timestamp?: string): string {
  if (!timestamp) return "unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function ActionPrompt({ children }: { children: React.ReactNode }) {
  return <Text color="yellow">{children} [y]es / [n]o</Text>;
}

export function Viewer({
  dir,
  initialSettings,
  onQuit
}: {
  dir: string;
  initialSettings?: Settings;
  onQuit?: () => void;
}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, setState] = useState<LoadResult>(() => loadState(dir));
  const [tabIndex, setTabIndex] = useState(0);
  const [selected, setSelected] = useState(0);
  const [detail, setDetail] = useState<Lane | null>(null);
  const [action, setAction] = useState<"pause" | "resume" | "rescue-confirm" | null>(null);
  const [message, setMessage] = useState("");
  const [rescueReading, setRescueReading] = useState<string | null>(null);
  const settings = state.settings || initialSettings;
  const tab = TABS[tabIndex] ?? "In Progress";
  const lanes = useMemo(() => tabLanes(state, tab), [state, tab]);

  useEffect(() => {
    const timer = setInterval(() => setState(loadState(dir)), 2000);
    return () => clearInterval(timer);
  }, [dir]);

  useEffect(() => {
    if (selected >= lanes.length) setSelected(Math.max(0, lanes.length - 1));
  }, [lanes.length, selected]);

  const quit = () => {
    onQuit?.();
    exit();
  };

  useInput((input, key) => {
    if (message) {
      if (input === "q" || key.escape) setMessage("");
      return;
    }
    if (!detail) {
      if (input === "q") return quit();
      if (input === "d" && settings) {
        const deputyEnabled = !settings.deputyEnabled;
        writeSettings(dir, { ...settings, deputyEnabled });
        setState((current) => ({ ...current, settings: { ...settings, deputyEnabled } }));
        setMessage(`Deputy turned ${deputyEnabled ? "on" : "off"}.`);
        return;
      }
      if (key.leftArrow) return setTabIndex((value) => (value + TABS.length - 1) % TABS.length);
      if (key.rightArrow) return setTabIndex((value) => (value + 1) % TABS.length);
      if (key.upArrow) return setSelected((value) => Math.max(0, value - 1));
      if (key.downArrow)
        return setSelected((value) => Math.min(Math.max(0, lanes.length - 1), value + 1));
      if (key.return && lanes[selected]) return setDetail(lanes[selected]);
      return;
    }
    if (rescueReading) {
      if (input === "y") {
        const used = spawnsSince(state.logs, state.runStarted);
        if (!settings || used >= settings.spawnBudget) {
          setMessage(
            `Rescue cannot start: the ${settings?.spawnBudget || 0}-start budget is exhausted.`
          );
        } else {
          try {
            acceptRescue(dir, detail, rescueReading);
            setMessage("Rescue agent started.");
            setRescueReading(null);
          } catch (error) {
            setMessage(error instanceof Error ? error.message : "Rescue could not start.");
          }
        }
      } else if (input === "p") {
        setAction(detail.paused ? "resume" : "pause");
        setRescueReading(null);
      } else if (input === "d" || key.escape) {
        setRescueReading(null);
      }
      return;
    }
    if (action) {
      if (input === "n" || key.escape) return setAction(null);
      if (input !== "y") return;
      if (action === "rescue-confirm") {
        if (!settings) return setMessage("Settings are not available yet.");
        setAction(null);
        setRescueReading("Thinking...");
        void askJudge(settings, story(detail, state))
          .then(setRescueReading)
          .catch((error) => {
            setRescueReading(null);
            setMessage(
              error instanceof Error ? error.message : "The judgment call failed; nothing changed."
            );
          });
        return;
      }
      try {
        const paused = action === "pause";
        setLane(
          dir,
          detail.issue,
          `paused=${paused}`,
          `pausedAt=${paused ? new Date().toISOString() : "null"}`,
          `pausedBy=${paused ? "human" : "null"}`
        );
        messageAgent(
          detail.agent,
          paused
            ? "Pause this lane at the next safe point and wait."
            : "The lane is resumed. Continue working."
        );
        logLane(dir, detail.issue, `human ${paused ? "paused" : "resumed"} the lane`);
        setAction(null);
        setMessage(paused ? "Lane paused." : "Lane resumed.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "The lane action failed.");
        setAction(null);
      }
      return;
    }
    if (key.escape) return setDetail(null);
    if (input === "p") return setAction(detail.paused ? "resume" : "pause");
    if (input === "r") return setAction("rescue-confirm");
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box>
        {TABS.map((name, index) => (
          <Text
            key={name}
            bold={index === tabIndex}
            color={index === tabIndex ? "cyan" : undefined}
          >
            {index === tabIndex ? `[ ${name} ]` : `  ${name}  `}
          </Text>
        ))}
        <Text> Deputy: {settings?.deputyEnabled ? "on" : "off"}</Text>
      </Box>
      <Text>←/→ tabs ↑/↓ select Enter detail q quit</Text>
      <Box flexDirection="column" marginTop={1}>
        {state.errors.map((lane) => (
          <Text key={`error-${lane.issue}`} color="red">
            # {lane.issue || "?"} error: {lane.error}
          </Text>
        ))}
        {state.lanes.length === 0 && state.errors.length === 0 && (
          <Text color="gray">
            The daemon has not ticked yet. Waiting for the first lane records.
          </Text>
        )}
        {state.lanes.length > 0 && lanes.length === 0 && (
          <Text color="gray">No lanes in this tab.</Text>
        )}
        {lanes.map((lane, index) => (
          <Text
            key={lane.issue}
            color={lane.question || lane.status === "blocked" ? "yellow" : undefined}
            inverse={index === selected}
          >
            {index === selected ? "❯ " : "  "}#{lane.issue} {laneTitle(lane)} —{" "}
            {STATUS_LABELS[lane.status || ""] || lane.status || "unknown"}
            {lane.pr ? ` (PR #${lane.pr})` : ""}
            {lane.paused ? " [paused]" : ""}
          </Text>
        ))}
      </Box>
      {detail && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{story(detail, state)}</Text>
          <Box marginTop={1}>
            <Text>Esc: back p: pause/resume r: rescue</Text>
          </Box>
          {action && (
            <ActionPrompt>
              {action === "pause"
                ? "Pause this lane?"
                : action === "resume"
                  ? "Resume this lane?"
                  : "Ask for a rescue preview?"}
            </ActionPrompt>
          )}
          {rescueReading && (
            <Text color="cyan">
              {rescueReading === "Thinking..."
                ? rescueReading
                : `Rescue preview:\n${rescueReading}\n\n[y] accept  [p] pause  [d] dismiss`}
            </Text>
          )}
        </Box>
      )}
      {message && (
        <Box marginTop={1}>
          <Text color="yellow">{message} (q to close)</Text>
        </Box>
      )}
      {stdout.columns !== undefined &&
        stdout.rows !== undefined &&
        (stdout.columns < 60 || stdout.rows < 12) && (
          <Text color="red">
            The terminal is too small. Resize it to at least 60 columns by 12 rows.
          </Text>
        )}
    </Box>
  );
}
