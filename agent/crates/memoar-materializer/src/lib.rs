//! Writes the native session bundles the archive builds, for gated targets.

mod antigravity;
mod bundle;
mod commit;
mod entry;
mod error;
mod memory;
mod memory_dialects;
mod paths;
mod target;
mod validate;

#[cfg(test)]
mod tests;

pub use crate::bundle::{
    BundleFile, ConversionBundle, MaterializationResult, bundle_sha256, content_sha256,
};
pub use crate::entry::materialize_bundle;
pub use crate::error::MaterializeError;
pub use crate::memory::{
    MemoryBundleFile, MemoryConversionBundle, MemoryConversionReport, MemoryMaterializationResult,
    materialize_memory_bundle, memory_bundle_preview, memory_bundle_sha256,
};
pub use crate::memory_dialects::{MemoryDestination, MemoryDialect, memory_destination};
pub use crate::target::Target;
