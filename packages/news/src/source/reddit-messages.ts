// packages/news/src/source/reddit-messages.ts
// #2282 — the two sentences a Reddit failure is shown as, in one place so the settings screen,
// the chat tool and the collector all say the same thing. Deliberately import-free: the settings
// bundle reads these, and pulling the feed reader in would drag feed parsing into the browser.

export const REDDIT_RATE_LIMIT_MESSAGE =
  "Reddit is rate limiting Moss. Headlines resume automatically.";
export const REDDIT_AUTH_REQUIRED_MESSAGE = "This subreddit is private or restricted.";
