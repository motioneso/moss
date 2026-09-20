"""Conservative, local duration accounting; no model calls or wall-clock timestamps."""


class FocusTracker:
    def __init__(self, threshold=300, probability=0.8, cooldown=1800, grace=135):
        self.threshold = threshold
        self.probability = probability
        self.cooldown = cooldown
        self.grace = grace
        self.last_flag = float("-inf")
        self.reset()

    def reset(self):
        # Cooldown survives a reset. All other state belongs to this episode.
        self.seconds = 0.0
        self.last_vote = None
        self.last_support = None
        self.last_tick = None
        self.context = None
        self.flagged = False

    def observe(self, now, context, idle=False):
        if (idle or (self.last_tick is not None and now - self.last_tick > 15)
                or (self.last_support is not None and now - self.last_support > self.grace)):
            self.reset()
        if context is None:
            self.last_vote = None  # Excluded apps remain gaps; allowed page changes can bridge.
        self.context = context
        self.last_tick = now

    def uncertain(self):
        self.last_vote = None  # Keep credited time briefly, but do not bridge this interval.

    def vote(self, now, alignment, probability):
        if self.last_support is not None and now - self.last_support > self.grace:
            self.reset()
        if probability is None or probability < self.probability:
            self.uncertain()
            return False
        if alignment in ("focused", "necessary_detour"):
            self.reset()
            return False
        if alignment != "distracted" or self.context is None:
            self.uncertain()
            return False
        # ponytail: endpoint estimate may include an unclassified intermediate page;
        # classify every transition if this measurably overcounts. Capture must remain continuous.
        if self.last_vote is not None:
            self.seconds += max(0, now - self.last_vote)
        self.last_vote = now
        self.last_support = now
        if self.seconds >= self.threshold and not self.flagged and now - self.last_flag >= self.cooldown:
            self.last_flag = now
            self.flagged = True
            return True
        return False
