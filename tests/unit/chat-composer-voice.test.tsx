import { readFileSync } from "node:fs";

import { createElement, StrictMode, type ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LookupAiCapabilityRouteResponse } from "@moss/shared";
import { queryKeys } from "../../apps/web/src/api/query-keys.js";
import {
  Composer,
  classifyMicError,
  mergeTranscriptIntoText
} from "../../apps/web/src/chat/composer.js";
import type * as ApiClientModule from "../../apps/web/src/api/client.js";

// Only override transcribeAudio — every other export keeps its real implementation so the
// existing tests in this file (which don't mock this module) are unaffected.
vi.mock("../../apps/web/src/api/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClientModule>();
  return { ...actual, transcribeAudio: vi.fn() };
});

import { transcribeAudio } from "../../apps/web/src/api/client.js";

// #738 — Chat voice input capture and transcription: composer-side coverage.
//
// mergeTranscriptIntoText is the pure function the mic control uses to land a transcript in the
// composer text for review/edit. Testing it directly proves transcription is an INSERT, never a
// send — there is no code path here that reaches for props.onSend.
describe("mergeTranscriptIntoText (#738 transcript insertion, never auto-send)", () => {
  it("seeds an empty composer with the trimmed transcript", () => {
    expect(mergeTranscriptIntoText("", "  hello there  ")).toBe("hello there");
  });

  it("appends to existing composer text with a single space, preserving what was typed", () => {
    expect(mergeTranscriptIntoText("remember to", "call the vet")).toBe("remember to call the vet");
  });

  it("is a true no-op on an empty or whitespace-only transcript (leaves current text untouched)", () => {
    expect(mergeTranscriptIntoText("  draft  ", "")).toBe("  draft  ");
    expect(mergeTranscriptIntoText("  draft  ", "   ")).toBe("  draft  ");
  });
});

describe("Composer mic control (#738)", () => {
  it("disables the mic with an explanatory tooltip when the transcription route is unavailable", async () => {
    const html = await renderComposer((client) => {
      client.setQueryData(queryKeys.ai.capability("transcription"), unavailableRoute());
    });

    const micButton = extractMicButtonTag(html);
    expect(micButton).toContain("disabled");
    expect(micButton).toContain("Set up a transcription model in Settings");
  });

  it("enables the mic once the transcription capability route reports available", async () => {
    const html = await renderComposer((client) => {
      client.setQueryData(queryKeys.ai.capability("transcription"), availableRoute());
    });

    const micButton = extractMicButtonTag(html);
    expect(micButton).not.toContain("disabled");
    expect(micButton).toContain('title="Record a voice message"');
  });

  it("keeps the mic disabled when the chat itself is read-only, even if voice is configured", async () => {
    const html = await renderComposer(
      (client) => {
        client.setQueryData(queryKeys.ai.capability("transcription"), availableRoute());
      },
      { readOnly: true }
    );

    expect(extractMicButtonTag(html)).toContain("disabled");
  });
});

// #900 — classifyMicError is a pure function, testable directly without any rendering.
describe("classifyMicError (#900)", () => {
  it("reports an insecure origin when mediaDevices is unavailable", () => {
    expect(classifyMicError(undefined, false)).toBe(
      "Voice input needs a secure connection (HTTPS). You're on an insecure origin."
    );
  });

  it("reports permission denied for NotAllowedError", () => {
    expect(classifyMicError(new DOMException("x", "NotAllowedError"), true)).toBe(
      "Microphone permission was denied. Enable it in your browser settings."
    );
  });

  it("reports permission denied for SecurityError (same bucket as NotAllowedError)", () => {
    expect(classifyMicError(new DOMException("x", "SecurityError"), true)).toBe(
      "Microphone permission was denied. Enable it in your browser settings."
    );
  });

  it("reports no microphone found for NotFoundError", () => {
    expect(classifyMicError(new DOMException("x", "NotFoundError"), true)).toBe(
      "No microphone found."
    );
  });

  it("reports no microphone found for NotReadableError", () => {
    expect(classifyMicError(new DOMException("x", "NotReadableError"), true)).toBe(
      "No microphone found."
    );
  });

  it("falls back to the generic message for an unclassified error", () => {
    expect(classifyMicError(new Error("weird"), true)).toBe(
      "Microphone access was denied or unavailable."
    );
  });
});

// #900 (insecure-origin branch) + #1134 (track cleanup on unmount) — interactive lifecycle,
// driven through react-test-renderer with stubbed globals since this project's vitest
// environment is node (no jsdom/MediaRecorder).
describe("Composer mic lifecycle (#900 insecure origin, #1134 track cleanup)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(transcribeAudio).mockClear();
  });

  it("shows the insecure-origin message and never calls getUserMedia when mediaDevices is absent", async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", {});

    const renderer = await renderInteractiveComposer((client) => {
      client.setQueryData(queryKeys.ai.capability("transcription"), availableRoute());
    });

    const micButton = findMicButton(renderer);
    await act(async () => {
      micButton.props.onClick();
    });

    expect(getUserMedia).not.toHaveBeenCalled();
    const errorText = renderer.root.findByProps({ className: "form-error" });
    expect(errorText.children).toEqual([
      "Voice input needs a secure connection (HTTPS). You're on an insecure origin."
    ]);

    act(() => {
      renderer.unmount();
    });
  });

  it("stops every acquired track when the composer unmounts mid-recording (#1134)", async () => {
    const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
    const stream = { getTracks: () => tracks };
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    const renderer = await renderInteractiveComposer((client) => {
      client.setQueryData(queryKeys.ai.capability("transcription"), availableRoute());
    });

    const micButton = findMicButton(renderer);
    await act(async () => {
      micButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(micButton.props["aria-label"]).toBe("Stop recording");

    act(() => {
      renderer.unmount();
    });

    for (const track of tracks) {
      expect(track.stop).toHaveBeenCalledOnce();
    }
  });

  it("stops a stream that resolves after unmount without starting a recorder (#1485 QA regression)", async () => {
    let resolveStream!: (stream: { getTracks: () => { stop: ReturnType<typeof vi.fn> }[] }) => void;
    const getUserMedia = vi.fn(
      () =>
        new Promise<{ getTracks: () => { stop: ReturnType<typeof vi.fn> }[] }>((resolve) => {
          resolveStream = resolve;
        })
    );
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] };
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    const recorder = vi.fn();
    vi.stubGlobal("MediaRecorder", recorder);

    const renderer = await renderInteractiveComposer((client) => {
      client.setQueryData(queryKeys.ai.capability("transcription"), availableRoute());
    });

    await act(async () => {
      findMicButton(renderer).props.onClick();
    });
    act(() => {
      renderer.unmount();
    });
    await act(async () => {
      resolveStream(stream);
      await Promise.resolve();
    });

    expect(track.stop).toHaveBeenCalledOnce();
    expect(recorder).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  // PR #1485 QA finding: real Chromium auto-stops an active MediaRecorder when its last live
  // track ends, firing ondataavailable+onstop *after* unmount. FakeMediaRecorder above stubs a
  // plain `{ stop: vi.fn() }` track that does NOT reproduce that — this fake track's stop()
  // invokes the recorder's own callbacks, the way the real browser does, so this test would have
  // failed against the pre-fix composer.tsx (onstop still bound → blob built → transcribeAudio
  // called post-unmount) and passes now that unmount detaches the callbacks first.
  it("never uploads a partial recording when the browser auto-stops the recorder after unmount (#900/#1134 QA regression)", async () => {
    const recorders: AutoStopFakeMediaRecorder[] = [];
    class AutoStopFakeMediaRecorder extends FakeMediaRecorder {
      constructor(stream: unknown) {
        super(stream);
        recorders.push(this);
      }
    }

    // A real MediaStreamTrack.stop() is idempotent — it only fires its end-of-track effects once.
    // Guard against a second invocation so this mirrors that instead of recursing forever: the
    // pre-fix onstop handler itself calls track.stop() again on every track before uploading.
    let trackStopped = false;
    const track = {
      stop: vi.fn(() => {
        if (trackStopped) return;
        trackStopped = true;
        const recorder = recorders[0];
        recorder?.ondataavailable?.({ data: { size: 5 } });
        recorder?.onstop?.();
      })
    };
    const stream = { getTracks: () => [track] };
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", AutoStopFakeMediaRecorder);

    const renderer = await renderInteractiveComposer((client) => {
      client.setQueryData(queryKeys.ai.capability("transcription"), availableRoute());
    });

    const micButton = findMicButton(renderer);
    await act(async () => {
      micButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(micButton.props["aria-label"]).toBe("Stop recording");

    await act(async () => {
      renderer.unmount();
      // Let the auto-stop-triggered onstop's async transcribeAndInsert microtasks settle.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
  });

  // Fable REVISE finding (fresh #900/#1134 adjudication): StrictMode double-invokes the mount
  // effect (setup → cleanup → setup) to verify cleanup safety. Without resetting
  // mountedRef.current back to true on the second setup, the simulated remount permanently
  // latches it to false and every mic start after that is wrongly treated as post-unmount —
  // the just-acquired stream gets stopped immediately and recording never starts. This test
  // would have failed against the pre-fix composer.tsx.
  it("still starts recording after a StrictMode-simulated remount (mountedRef reset regression)", async () => {
    const tracks = [{ stop: vi.fn() }];
    const stream = { getTracks: () => tracks };
    const getUserMedia = vi.fn(async () => stream);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    const renderer = await renderInteractiveComposer(
      (client) => {
        client.setQueryData(queryKeys.ai.capability("transcription"), availableRoute());
      },
      { strictMode: true }
    );

    const micButton = findMicButton(renderer);
    await act(async () => {
      micButton.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(micButton.props["aria-label"]).toBe("Stop recording");
    for (const track of tracks) {
      expect(track.stop).not.toHaveBeenCalled();
    }

    act(() => {
      renderer.unmount();
    });

    for (const track of tracks) {
      expect(track.stop).toHaveBeenCalledOnce();
    }
  });

  it("does not throw on unmount when no recording was ever started", async () => {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });

    const renderer = await renderInteractiveComposer((client) => {
      client.setQueryData(queryKeys.ai.capability("transcription"), availableRoute());
    });

    expect(() => {
      act(() => {
        renderer.unmount();
      });
    }).not.toThrow();
  });
});

class FakeMediaRecorder {
  ondataavailable: ((event: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;
  mimeType = "audio/webm";
  constructor(_stream: unknown) {}
  start() {
    /* no-op */
  }
}

function findMicButton(renderer: ReactTestRenderer) {
  return renderer.root.find(
    (node) =>
      node.type === "button" &&
      (node.props["aria-label"] === "Record voice message" ||
        node.props["aria-label"] === "Stop recording")
  );
}

async function renderInteractiveComposer(
  seed: (client: QueryClient) => void,
  overrides: Partial<{ readOnly: boolean; strictMode: boolean }> = {}
): Promise<ReactTestRenderer> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  const tree = createElement(
    QueryClientProvider,
    { client },
    createElement(Composer, {
      readOnly: overrides.readOnly ?? false,
      isFounder: false,
      isSending: false,
      sendError: null,
      needsProvider: false,
      lockedModelUnavailable: false,
      privateMode: false,
      onSend: () => {},
      onStop: () => {}
    }) as ReactElement
  );
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(overrides.strictMode ? createElement(StrictMode, null, tree) : tree);
  });
  return renderer;
}

/** Extracts the mic `<button ...>` opening tag, regardless of the order React writes attributes. */
function extractMicButtonTag(html: string): string {
  const start = html.indexOf('<button aria-label="Record voice message"');
  if (start === -1) {
    const altStart = html.indexOf('<button aria-label="Stop recording"');
    if (altStart === -1) throw new Error("mic button not found in rendered HTML");
    return html.slice(altStart, html.indexOf(">", altStart) + 1);
  }
  return html.slice(start, html.indexOf(">", start) + 1);
}

// Defense-in-depth source guard: transcription is required to land in the composer for
// review/edit, never to auto-send. This directly inspects the handlers that own the mic
// recording lifecycle so a future edit that wires the mic to onSend fails CI immediately,
// rather than only being caught by interaction tests this project's test setup (node
// environment, no jsdom) cannot run against MediaRecorder.
describe("Composer source guard: voice input never auto-sends (#738)", () => {
  it("does not call onSend from the recording/transcription handlers", () => {
    const source = readFileSync(
      new URL("../../apps/web/src/chat/composer.tsx", import.meta.url),
      "utf8"
    );
    const startIndex = source.indexOf("const startRecording");
    const endIndex = source.indexOf("const micDisabled");
    expect(startIndex).toBeGreaterThan(-1);
    expect(endIndex).toBeGreaterThan(startIndex);

    const voiceInputHandlers = source.slice(startIndex, endIndex);
    expect(voiceInputHandlers).not.toContain("props.onSend");
    expect(voiceInputHandlers).toContain("insertTranscript");
  });
});

function unavailableRoute(): LookupAiCapabilityRouteResponse {
  return {
    route: { capability: "transcription", available: false, reason: "no-active-model", model: null }
  };
}

function availableRoute(): LookupAiCapabilityRouteResponse {
  return {
    route: {
      capability: "transcription",
      available: true,
      reason: "matched-active-model",
      model: {
        id: "model-1",
        providerConfigId: "provider-1",
        providerKind: "openai-compatible",
        providerDisplayName: "Voice provider",
        providerStatus: "active",
        providerModelId: "whisper-1",
        displayName: "Whisper",
        capabilities: ["transcription"],
        status: "active",
        tier: "interactive",
        allowUserOverride: true,
        origin: "discovered",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z"
      }
    }
  };
}

async function renderComposer(
  seed: (client: QueryClient) => void,
  overrides: Partial<{ readOnly: boolean }> = {}
): Promise<string> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed(client);
  return renderToString(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Composer, {
        readOnly: overrides.readOnly ?? false,
        isFounder: false,
        isSending: false,
        sendError: null,
        needsProvider: false,
        lockedModelUnavailable: false,
        privateMode: false,
        onSend: () => {},
        onStop: () => {}
      }) as ReactElement
    )
  );
}
