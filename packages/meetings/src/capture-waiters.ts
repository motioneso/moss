import { MeetingCaptureError } from "./capture-domain.js";
/** Bounded local wakeups; the five-second refresh also works across API processes. */
export class CaptureWaiters {
  private readonly waiters = new Map<string, Set<() => void>>();
  private count = 0;
  notify(key: string) {
    for (const wake of this.waiters.get(key) ?? []) wake();
  }
  async wait(key: string, milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || milliseconds <= 0) return;
    if (this.count >= 512 || (this.waiters.get(key)?.size ?? 0) >= 4)
      throw new MeetingCaptureError("meeting_capture_rate_limited", 429);
    await new Promise<void>((resolve) => {
      const listeners = this.waiters.get(key) ?? new Set<() => void>();
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        listeners.delete(finish);
        this.count--;
        if (!listeners.size) this.waiters.delete(key);
        resolve();
      };
      const timer = setTimeout(finish, Math.min(5000, milliseconds));
      listeners.add(finish);
      this.waiters.set(key, listeners);
      this.count++;
      signal?.addEventListener("abort", finish, { once: true });
    });
  }
}
