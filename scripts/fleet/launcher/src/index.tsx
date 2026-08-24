import React, { useEffect, useState } from "react";
import { Box, render, Text, useInput } from "ink";
import { Viewer } from "./view.js";
import { cloneDefaults, parseBuildAnswers, SETUP_QUESTIONS } from "./setup.js";
import { daemonActive, startDaemon } from "./operations.js";
import { readSettings, stateDir, writeRunStarted, writeSettings } from "./state.js";
import type { Settings } from "./types.js";

function Setup({
  dir,
  onDone
}: {
  dir: string;
  onDone: (settings: Settings, error?: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [value, setValue] = useState("");
  const [settings, setSettings] = useState(cloneDefaults());
  useInput((input, key) => {
    if (key.return) {
      const next = { ...settings };
      if (step === 0 && value.trim()) next.judgeCmd = value.trim();
      if (step === 1) setSettings(parseBuildAnswers(value, next));
      if (step === 2 && Number.isFinite(Number(value)) && Number(value) > 0)
        next.laneCap = Number(value);
      if (step === 3 && Number.isFinite(Number(value)) && Number(value) > 0)
        next.spawnBudget = Number(value);
      if (step === 4 && value.trim()) next.deputyEnabled = /^(y|yes|on|true)$/i.test(value.trim());
      if (step === 5 && Number.isFinite(Number(value)) && Number(value) >= 0)
        next.deputyWaitSeconds = Number(value);
      if (step === SETUP_QUESTIONS.length - 1 || (step === 4 && !next.deputyEnabled)) {
        writeSettings(dir, next);
        try {
          startDaemon(dir);
          writeRunStarted(dir);
          onDone(next);
        } catch (error) {
          onDone(
            next,
            error instanceof Error ? error.message : "The fleet service could not start."
          );
        }
      } else {
        setSettings(next);
        setStep(step + 1);
        setValue("");
      }
      return;
    }
    if (key.backspace || key.delete) return setValue((current) => current.slice(0, -1));
    if (input && !key.ctrl && !key.meta) setValue((current) => current + input);
  });
  const defaults =
    step === 0
      ? "claude -p"
      : step === 1
        ? "routine program/model/effort, sensitive program/model/effort, security program/model/effort"
        : step === 2
          ? "5"
          : step === 3
            ? "30"
            : step === 4
              ? "off"
              : "1200";
  return (
    <Box flexDirection="column">
      <Text>
        {SETUP_QUESTIONS[step]} [{defaults}]
      </Text>
      <Text>&gt; {value}</Text>
    </Box>
  );
}

function StartPrompt({
  dir,
  initialError,
  onStarted,
  onQuit
}: {
  dir: string;
  initialError: string;
  onStarted: () => void;
  onQuit: () => void;
}) {
  const [error, setError] = useState(initialError);
  useInput((input, key) => {
    if (input === "q") return onQuit();
    if (input === "s") {
      try {
        startDaemon(dir);
        writeRunStarted(dir);
        onStarted();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The daemon could not be started.");
      }
    }
    if (key.escape) onQuit();
  });
  return (
    <Box flexDirection="column">
      <Text color="yellow">
        The fleet daemon is not running. Press [s] to start it, or [q] to quit.
      </Text>
      {error && <Text color="red">{error}</Text>}
    </Box>
  );
}

function Root() {
  const dir = stateDir();
  const [settings, setSettings] = useState<Settings | null>(() => readSettings(dir));
  const [closed, setClosed] = useState(false);
  const [started, setStarted] = useState(() => Boolean(settings && daemonActive()));
  const [daemonRunning, setDaemonRunning] = useState(() => Boolean(settings && daemonActive()));
  const [startupError, setStartupError] = useState("");
  useEffect(() => {
    if (!settings) return;
    const timer = setInterval(() => setDaemonRunning(daemonActive()), 2000);
    return () => clearInterval(timer);
  }, [settings]);
  if (closed) return null;
  if (!settings)
    return (
      <Setup
        dir={dir}
        onDone={(next, error) => {
          setSettings(next);
          setStartupError(error || "");
          setStarted(!error);
          setDaemonRunning(!error);
        }}
      />
    );
  if (!daemonRunning && !started)
    return (
      <StartPrompt
        dir={dir}
        initialError={startupError}
        onStarted={() => {
          setStarted(true);
          setDaemonRunning(true);
          setStartupError("");
        }}
        onQuit={() => setClosed(true)}
      />
    );
  return <Viewer dir={dir} initialSettings={settings} daemonRunning={daemonRunning} />;
}

render(<Root />);
