/**
 * Tracks stories the user dismissed in this browser tab, keyed by feedback reference.
 *
 * A news refresh can be requested before a dismissal finishes saving. If that older refresh's
 * answer arrives after the dismissal, it must not bring the story back. `getNewsOverview` checks
 * this list on every answer it hands back, so a late answer gets the same story removed and its
 * carousel refilled, no matter which finishes first.
 */
const dismissedFeedbackRefs = new Set<string>();

export function markStoryDismissed(feedbackRef: string): void {
  dismissedFeedbackRefs.add(feedbackRef);
}

/** Call after a saved dismissal is successfully removed so the story can appear again. */
export function clearStoryDismissed(feedbackRef: string): void {
  dismissedFeedbackRefs.delete(feedbackRef);
}

export function isStoryDismissed(feedbackRef: string | undefined): boolean {
  return feedbackRef !== undefined && dismissedFeedbackRefs.has(feedbackRef);
}

/** Test-only: clears the tracked list so one test's dismissals don't leak into the next. */
export function resetDismissedStoriesForTests(): void {
  dismissedFeedbackRefs.clear();
}
