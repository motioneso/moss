CREATE TABLE app.news_story_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  story_ref TEXT NOT NULL CHECK (char_length(story_ref) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (kind IN ('more_like_this', 'less_like_this')),
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, story_ref)
);
