//! Downloaded code enters through verified packages and the component linker only.
pub mod archive;
pub mod bundle;
pub mod manifest;
pub mod registry;
pub mod registry_review;
pub mod runtime;
pub mod sql;
pub mod staged;
pub mod store;
pub mod trust;

pub mod database;
pub mod lifecycle;
pub mod linked_notes;
pub mod local;
pub mod local_packages;
pub mod migrations;
pub mod postgres;

pub mod recovery;
pub mod revocation;

pub mod jobs;
/// The companion device lookup, view and narrow write functions. Needs the Meetings tables.
pub mod companion_devices {
    pub const MIGRATION: &str = include_str!("../sql/0004_companion_devices.sql");
}
pub mod approval_port;
pub mod purge_hooks;

pub mod ai;
pub mod browser;
pub mod credentials;
pub mod feedback_port;
pub mod network;
pub mod proactive_cards;
pub mod public_web;
pub mod robots;
pub mod route_image;
pub mod services;
pub mod usefulness_feedback;

pub mod legacy;
pub mod rls;

mod db_snapshot;

pub mod application;

mod compiled;

pub mod registry_manager;

mod backfills;

pub mod metadata;

mod tool_names;

pub mod after_commit_jobs;
mod command_records;
mod enqueue_options;

pub mod typed_query;

pub mod transactional_database;
pub mod transcribe;

pub mod dispatch;

pub mod context;

mod application_extended;
pub mod frame;
pub mod guest_component;

pub mod account_contracts;
pub mod account_preferences;
pub mod folder_settings;
pub mod folder_sync_status;
pub mod memory_cleanup;
pub mod memory_ingest;
pub mod memory_search;
pub mod memory_snapshot;
pub mod memory_vault;

mod notifications;
mod producer_queue;
pub mod quiet_hours;
pub mod worker;

mod chat_schema;
mod chat_services;
pub mod chat_tools;
mod invocation;

mod activation;
pub mod local_lifecycle;

mod catalog_storage;

pub mod module_policy;
