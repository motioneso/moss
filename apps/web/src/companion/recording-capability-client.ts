import { ApiError } from "@moss/module-web-sdk";
import type {
  DecideRecordingCapabilityInput,
  DecideRecordingCapabilityResponse
} from "@moss/shared";

/** Retry the same approved capability decision only while its signed-in owner is still current. */
export async function decideRecordingCapability(
  input: DecideRecordingCapabilityInput,
  currentSession: () => boolean
): Promise<DecideRecordingCapabilityResponse> {
  const controller = new AbortController();
  const deadline = Date.now() + 10000;
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!currentSession()) throw new Error("Connection approval session changed");
      const response = await fetch("/api/companion/recording-capability/decide", {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: controller.signal
      });
      if (!currentSession()) throw new Error("Connection approval session changed");
      if (response.ok) return (await response.json()) as DecideRecordingCapabilityResponse;
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const delay = Math.max(
        250,
        Number.isFinite(seconds)
          ? seconds * 1000
          : retryAfter
            ? Date.parse(retryAfter) - Date.now()
            : 1000
      );
      if (response.status === 429 && attempt < 2 && Date.now() + delay < deadline) {
        await response.arrayBuffer();
        await new Promise<void>((resolve, reject) => {
          const sleep = setTimeout(resolve, delay);
          controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(sleep);
              reject(new Error("Connection approval timed out"));
            },
            { once: true }
          );
        });
        continue;
      }
      throw new ApiError(response.status, "Couldn’t confirm the connection update");
    }
    throw new Error("Connection approval retry limit reached");
  } finally {
    clearTimeout(timer);
  }
}
