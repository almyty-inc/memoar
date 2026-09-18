//! Native session bundle materialization for gated conversion targets.

mod antigravity;
mod bundle;
mod claude;
mod codex;
mod commit;
mod entry;
mod error;
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
pub use crate::target::Target;
