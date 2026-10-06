import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "@moss/module-web-sdk";
import { MeetingMarkdownCopy } from "../../packages/meetings/src/web/meeting-markdown-copy.js";
import { useMeetingTranscript } from "../../packages/meetings/src/web/meeting-transcript.js";
vi.mock("../../packages/meetings/src/web/meeting-transcript.js", () => ({
  useMeetingTranscript: vi.fn()
}));
let renderer: ReactTestRenderer;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
it.each([401, 403, 404])(
  "omits retained transcript bytes from Markdown after denial %s",
  async (status) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.mocked(useMeetingTranscript).mockReturnValue({
      data: {
        snapshot: {
          segments: [{ startMs: 0, text: "Retained private transcript" }],
          omittedSegments: 0
        }
      },
      isError: true,
      error: new ApiError(status, "meeting_not_found", "Unavailable")
    } as unknown as ReturnType<typeof useMeetingTranscript>);
    await act(async () => {
      renderer = create(
        <MeetingMarkdownCopy
          meeting={{
            id: "11223344-1122-4122-8122-112233445566",
            title: "Meeting",
            personalNotes: "Saved notes",
            notesRevision: 1,
            createdAt: "2026-10-06T00:00:00Z",
            updatedAt: "2026-10-06T00:00:00Z"
          }}
        />
      );
    });
    const value = renderer.root.findByType("textarea").props.value as string;
    expect(value).toContain("Saved notes");
    expect(value).not.toContain("Retained private transcript");
    await act(async () => renderer.root.findByType("button").props.onClick());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(value);
    expect(writeText.mock.calls[0]![0]).not.toContain("Retained private transcript");
  }
);
