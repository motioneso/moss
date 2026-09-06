/**
 * Page-trail bridge: the host top bar can show "section / name · meta" while a module page is
 * mounted, without the module importing the web app (module isolation).
 *
 * The host (`apps/web/src/shell/page-trail.tsx`) owns the state and registers its hook here once
 * at module load. A module calls `usePageTrail` exactly like a normal hook; before the host has
 * registered (tests, external bundles with their own SDK copy) it is a safe no-op so a page never
 * crashes for lack of a shell.
 *
 * The registered function is stable for the life of the app — the host sets it once at module
 * scope, never during render — so calling it unconditionally here keeps hook order stable.
 */
export interface PageTrailInput {
  /** The name shown in the top bar while the calling page is mounted. */
  readonly name: string;
  /** Small trailing note, hidden on narrow screens. */
  readonly meta?: string | null;
}

export type PageTrailHook = (input: PageTrailInput) => void;

function noopPageTrailHook(_input: PageTrailInput): void {
  // No shell has registered: fail closed, leave the plain top-bar title alone.
}

let hookImpl: PageTrailHook = noopPageTrailHook;

/** Host-only: called once by `apps/web/src/shell/page-trail.tsx` at module load. */
export function setPageTrailHook(impl: PageTrailHook): void {
  hookImpl = impl;
}

/**
 * While the calling page is mounted the top bar shows section / name / meta; on unmount it
 * clears back to the plain title.
 */
export function usePageTrail(input: PageTrailInput): void {
  hookImpl(input);
}
