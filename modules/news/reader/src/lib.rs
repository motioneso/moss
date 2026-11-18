//! Shared feed reader for the News and Sports packages.
//!
//! A pure library. It takes text in and gives values out. It opens no connection, reads no file,
//! and writes no log. Callers fetch the bytes and hand them over.

pub mod body_image;
pub mod feed;
pub mod html;
pub mod publisher;
pub mod reddit;
pub mod sanitize;
pub mod url;
mod xml;

pub use feed::{
    is_public_feed_document, parse_feed_xml, parse_public_feed_items, stable_id_for_url,
    to_feed_items, FeedItem, RawFeedItem,
};
pub use publisher::{publisher_identity, same_publisher};
pub use reddit::{
    parse_reddit_feed, parse_subreddit_input, read_subreddit, reddit_entry_to_headline,
    reddit_failure_reason, reddit_fetch_options, reddit_hop_guard, reddit_hot_feed_url,
    reddit_outbound_link, reddit_subreddit_url, subreddit_name_from_url, ReadSubredditResult,
    RedditFailureReason, RedditFeed, RedditFetchFailure, RedditFetchOptions, RedditFetchResult,
    RedditFetched, RedditHop, RedditLinkedHeadline, RedditReaderOptions, RedditSubredditInfo,
    SubredditInput,
};
pub use sanitize::{
    decode_entities, sanitize_feed_text, sanitize_image_url, sanitize_item_url,
    sanitize_published_at, SUMMARY_CHAR_CAP, TITLE_CHAR_CAP,
};
