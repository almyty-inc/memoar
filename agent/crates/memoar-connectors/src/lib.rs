//! Parse-free discovery of native coding-agent session stores.

pub mod memory;

mod discovery;
mod glob;
mod sources;
mod spec;

#[cfg(test)]
mod collection_tests;
#[cfg(test)]
mod tests;

pub use crate::discovery::{
    DiscoveryError, SourceDiscovery, discover, discover_with_env, files_for_source,
    files_for_source_with_env, source,
};
pub use crate::sources::SOURCES;
pub use crate::spec::{OperatingSystem, SourceSpec, Stability};
