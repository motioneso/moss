//! Downloaded code enters through verified packages and the component linker only.
pub mod archive;
pub mod manifest;
pub mod registry;
pub mod runtime;
pub mod sql;
pub mod store;
pub mod trust;

pub mod database;
pub mod lifecycle;
pub mod local;
pub mod migrations;
pub mod postgres;

pub mod recovery;

pub mod jobs;

pub mod ai;
pub mod credentials;
pub mod network;
pub mod services;

pub mod legacy;
pub mod rls;

mod db_snapshot;

pub mod application;

mod compiled;

pub mod registry_manager;

mod backfills;

pub mod metadata;

mod tool_names;
