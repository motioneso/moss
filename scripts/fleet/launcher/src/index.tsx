import React, { useState } from "react";
import { render, Text, useInput } from "ink";
import fs from "node:fs";
import { Viewer } from "./view.js";
import { cloneDefaults, parseModelAnswers, SETUP_QUESTIONS } from "./setup.js";
import { daemonActive, startDaemon } from "./operations.js";
import { stateDir, writeRunStarted, writeSettings } from "./state.js";
import type { Settings } from "./types.js";

function Setup({ dir, onDone }: { dir: string; onDone: (settings: Settings) => void }) {
  const [step, setStep] = useState(0);
  const [value, setValue] = useState("");
  const [settings, setSettings] = useState(cloneDefaults());
  useInput((input, key) => {
    if (key.return) {
      const next = { ...settings };
      if (step === 0 && value.trim()) next.judgeCmd = value.trim();
      if (step === 1) setSettings(parseModelAnswers(value, next));
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
          startDaemon();
          writeRunStarted(dir);
        } catch {
          /* the viewer gives the user a start option */
        }
        onDone(next);
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
        ? "routine, sensitive, security"
        : step === 2
          ? "5"
          : step === 3
            ? "30"
            : step === 4
              ? "off"
              : "1200";
  return (
    <Text>
      {SETUP_QUESTIONS[step]} [{defaults}]\n&gt; {value}
    </Text>
  );
}

function StartPrompt({ onStarted, onQuit }: { onStarted: () => void; onQuit: () => void }) {
  const [error, setError] = useState("");
  useInput((input, key) => {
    if (input === "q") return onQuit();
    if (input === "s") {
      try {
        startDaemon();
        onStarted();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : "The daemon could not be started.");
      }
    }
    if (key.escape) onQuit();
  });
  return (
    <Text color="yellow">
      The fleet daemon is not running. Press [s] to start it, or [q] to quit.
      {error ? ` ${error}` : ""}
    </Text>
  );
}

function Root() {
  const dir = stateDir();
  const [settings, setSettings] = useState<Settings | null>(() => {
    try {
      return JSON.parse(fs.readFileSync(`${dir}/settings.json`, "utf8")) as Settings;
    } catch {
      return null;
    }
  });
  const [closed, setClosed] = useState(false);
  const [started, setStarted] = useState(false);
  if (closed) return null;
  if (!settings) return <Setup dir={dir} onDone={setSettings} />;
  if (!daemonActive() && !started)
    return (
      <StartPrompt
        onStarted={() => {
          writeRunStarted(dir);
          setStarted(true);
        }}
        onQuit={() => setClosed(true)}
      />
    );
  return <Viewer dir={dir} initialSettings={settings} />;
}

render(<Root />);
