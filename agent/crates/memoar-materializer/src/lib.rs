//! Native session bundle materialization for gated conversion targets.

mod antigravity;
mod bundle;
mod claude;
mod codex;
mod commit;
mod entry;
mod error;
mod memory;
mod memory_dialects;
mod native;
mod paths;
mod target;
mod validate;

#[cfg(test)]
mod tests;

pub use crate::bundle::{
    BundleFile, CanonicalConversionBundle, ConversionBundle, ConversionReport,
    MaterializationResult, MaterializedReport, bundle_sha256, content_sha256,
};
pub use crate::entry::{materialize, materialize_bundle, materialize_canonical_bundle};
pub use crate::error::MaterializeError;
pub use crate::memory::{
    MemoryBundleFile, MemoryConversionBundle, MemoryConversionReport, MemoryMaterializationResult,
    materialize_memory_bundle, memory_bundle_preview, memory_bundle_sha256,
};
pub use crate::memory_dialects::{MemoryDestination, MemoryDialect, memory_destination};
pub use crate::target::Target;
