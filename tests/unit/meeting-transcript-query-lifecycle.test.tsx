import { QueryClient, QueryObserver, focusManager } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { transcriptQueryOptions } from "../../packages/meetings/src/web/meeting-transcript.js";
import { evidenceQueryOptions } from "../../packages/meetings/src/web/transcript-evidence.js";
import { meetingRecordQueryOptions } from "../../packages/meetings/src/web/client.js";

const reference = {
  meetingId: "first",
  segmentId: "segment",
  segmentRevision: 1,
  startCharacter: 0,
  endCharacter: 8
};
const cases = [
  ["transcript", () => transcriptQueryOptions("first")],
  ["evidence", () => evidenceQueryOptions("first", reference)],
  ["record", () => meetingRecordQueryOptions("first")]
] as const;
afterEach(() => {
  vi.unstubAllGlobals();
  focusManager.setFocused(undefined);
});

describe("private meeting query lifecycle under shell defaults", () => {
  it.each(cases)(
    "revalidates %s immediately on focus and observes denial",
    async (_name, options) => {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('{"private":"first"}'))
        .mockResolvedValueOnce(new Response('{"code":"unavailable"}', { status: 403 }));
      vi.stubGlobal("fetch", fetch);
      const client = new QueryClient({
        defaultOptions: { queries: { staleTime: 15000, refetchOnWindowFocus: false, retry: false } }
      });
      client.mount();
      // QueryObserver is the actual lifecycle used by useQuery, with the shipped options.
      const observer = new QueryObserver<unknown>(client, options());
      const unsubscribe = observer.subscribe(() => {});
      try {
        await vi.waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true));
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        await vi.waitFor(() => expect(observer.getCurrentResult().isError).toBe(true));
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(observer.getCurrentResult().error).toMatchObject({ status: 403 });
      } finally {
        unsubscribe();
        client.unmount();
        client.clear();
      }
    }
  );

  it("aborts an old meeting request and ignores late completion after changing IDs", async () => {
    let resolveOld!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValueOnce(new Response('{"snapshot":{"meetingId":"second"},"sources":[]}'));
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 15000, refetchOnWindowFocus: false } }
    });
    const observer = new QueryObserver(client, transcriptQueryOptions("first"));
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const signal = fetch.mock.calls[0]![1].signal as AbortSignal;
      observer.setOptions(transcriptQueryOptions("second"));
      expect(signal.aborted).toBe(true);
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data?.snapshot.meetingId).toBe("second")
      );
      resolveOld(new Response('{"snapshot":{"meetingId":"first"},"sources":[]}'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(observer.getCurrentResult().data?.snapshot.meetingId).toBe("second");
      expect(client.getQueryData(transcriptQueryOptions("first").queryKey)).toBeUndefined();
    } finally {
      unsubscribe();
      client.clear();
    }
  });

  it("aborts a previous evidence range instead of showing it under a new reference", async () => {
    let resolveOld!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockResolvedValueOnce(new Response('{"evidence":{"excerpt":"second range","segment":{}}}'));
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient({
      defaultOptions: { queries: { staleTime: 15000, refetchOnWindowFocus: false } }
    });
    const observer = new QueryObserver(client, evidenceQueryOptions("first", reference));
    const unsubscribe = observer.subscribe(() => {});
    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const signal = fetch.mock.calls[0]![1].signal as AbortSignal;
      observer.setOptions(evidenceQueryOptions("first", { ...reference, segmentRevision: 2 }));
      expect(signal.aborted).toBe(true);
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data?.evidence.excerpt).toBe("second range")
      );
      resolveOld(new Response('{"evidence":{"excerpt":"old private range","segment":{}}}'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(observer.getCurrentResult().data?.evidence.excerpt).toBe("second range");
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
