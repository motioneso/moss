//! Host layer for connected-tool sorting: the connection routes, the sort job and the stored
//! rows. It stays in the host with chat and is not a package.
pub mod jobs;
pub mod manifest;
pub mod mcp;
pub mod ports;
pub mod routes;
pub mod store;
pub mod validate;
pub mod view;
