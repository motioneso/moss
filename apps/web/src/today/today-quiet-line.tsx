/** One quiet line standing in for the briefing, now-list and evening review
    when none of them has anything to show. The briefing's not-ready reason
    stays in the hero above. */
export function TodayQuietLine() {
  return (
    <section className="today-quiet-line" id="start-here" aria-label="Your day so far">
      <p className="today-quiet-line__text" role="status">
        Nothing else yet today: no briefing, nothing pressing, and no evening review.
      </p>
    </section>
  );
}
