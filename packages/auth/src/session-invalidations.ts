import type { BetterAuthOptions } from "better-auth";

export type SessionInvalidation =
  | { readonly actorUserId: string; readonly sessionId: string }
  | { readonly actorUserId: string; readonly exceptSessionId?: string };

/** Local auth-owned notifications; null ends every subscription on runtime shutdown. */
export class SessionInvalidations {
  readonly #listeners = new Set<(event: SessionInvalidation | null) => void>();
  #closed = false;

  subscribe(listener: (event: SessionInvalidation | null) => void): () => void {
    if (this.#closed || this.#listeners.size >= 16)
      throw new Error("Session notifications unavailable");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  invalidate(event: SessionInvalidation): void {
    if (!this.#closed) this.#notify(Object.freeze({ ...event }));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#notify(null);
    this.#listeners.clear();
  }

  #notify(event: SessionInvalidation | null): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        this.#listeners.delete(listener);
      }
    }
  }
}

/** Completion notification also retires capabilities issued while deletion was pending. */
export async function withSessionInvalidation<T>(
  source: SessionInvalidations | undefined,
  event: SessionInvalidation,
  operation: () => Promise<T>
): Promise<T> {
  source?.invalidate(event);
  try {
    return await operation();
  } finally {
    source?.invalidate(event);
  }
}

export function sessionInvalidationHooks(
  source: SessionInvalidations | undefined
): NonNullable<NonNullable<BetterAuthOptions["databaseHooks"]>["session"]> {
  return {
    delete: {
      before: async (row) => {
        source?.invalidate({ actorUserId: row.userId, sessionId: row.id });
      },
      after: async (row) => {
        source?.invalidate({ actorUserId: row.userId, sessionId: row.id });
      }
    }
  };
}
