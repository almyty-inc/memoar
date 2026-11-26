//! Reading a capture source as the plaintext its parser reads.
//!
//! Codex compresses a rollout it has not touched for a while into
//! `rollout-*.jsonl.zst` and deletes the `.jsonl`
//! (`codex-rs/rollout/src/compression.rs`). On the machine this was written
//! on that was 3,405 of 3,879 rollouts. The agent decompresses here, before
//! anything else sees the bytes, for two reasons:
//!
//! - Redaction rewrites text. Applied to zstd frames it can match nothing, and
//!   it must never be the reason a secret goes up unscanned.
//! - The archive names a session by where it was captured. Codex moves a
//!   rollout between `x.jsonl` and `x.jsonl.zst` in both directions (it
//!   decompresses one again to append to it), so the path the archive is told
//!   is the plain one. One conversation stays one session across the move.

use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::path::Path;

use crate::error::DaemonError;
use crate::transport::MAX_ARTIFACT_BYTES;

const ZSTD_SUFFIX: &str = ".zst";

/// Whether the file at `path` is stored zstd-compressed.
pub(crate) fn is_compressed(path: &Path) -> bool {
    path.file_name()
        .is_some_and(|name| name.to_string_lossy().ends_with(ZSTD_SUFFIX))
}

/// The path the archive is told: the plain name of a compressed file.
pub(crate) fn logical_source_path(path: &str) -> &str {
    path.strip_suffix(ZSTD_SUFFIX).unwrap_or(path)
}

/// The whole file, decompressed when it is stored compressed.
pub(crate) fn read_source(path: &Path) -> Result<Vec<u8>, DaemonError> {
    if !is_compressed(path) {
        return fs::read(path).map_err(|source| DaemonError::Io {
            path: path.to_path_buf(),
            source,
        });
    }
    let file = File::open(path).map_err(|source| DaemonError::Io {
        path: path.to_path_buf(),
        source,
    })?;
    decompress(path, file, MAX_ARTIFACT_BYTES)
}

/// At most `limit` bytes from the start of the plaintext, or `None`.
pub(crate) fn read_head(path: &Path, limit: usize) -> Option<Vec<u8>> {
    let file = File::open(path).ok()?;
    let mut head = Vec::with_capacity(limit);
    if is_compressed(path) {
        let decoder = ruzstd::decoding::StreamingDecoder::new(file).ok()?;
        // A frame cut short past the head still gave the head.
        let _ = decoder.take(limit as u64).read_to_end(&mut head);
    } else {
        file.take(limit as u64).read_to_end(&mut head).ok()?;
    }
    Some(head)
}

/// Decodes one zstd stream, refusing plaintext past `limit`.
///
/// The compressed size says nothing about the plaintext, so the ceiling the
/// archive accepts is checked against what comes out, and a stream that
/// expands past it is refused before it is held in memory whole.
fn decompress(path: &Path, input: impl Read, limit: u64) -> Result<Vec<u8>, DaemonError> {
    let undecodable = |message: String| DaemonError::Undecodable {
        path: path.to_path_buf(),
        message,
    };
    let decoder = ruzstd::decoding::StreamingDecoder::new(input)
        .map_err(|error| undecodable(error.to_string()))?;
    let mut plain = Vec::new();
    decoder
        .take(limit + 1)
        .read_to_end(&mut plain)
        .map_err(|error| match error.kind() {
            ErrorKind::NotFound | ErrorKind::PermissionDenied => DaemonError::Io {
                path: path.to_path_buf(),
                source: error,
            },
            _ => undecodable(error.to_string()),
        })?;
    if plain.len() as u64 > limit {
        return Err(DaemonError::TooLarge {
            path: path.to_path_buf(),
            size: plain.len() as u64,
            limit,
        });
    }
    Ok(plain)
}

#[cfg(test)]
mod tests {
    use super::{decompress, is_compressed, logical_source_path, read_head, read_source};
    use crate::error::DaemonError;
    use ruzstd::encoding::{CompressionLevel, compress_to_vec};
    use std::path::Path;

    const ROLLOUT: &[u8] =
        b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"r\",\"cwd\":\"/w\"}}\n";

    #[test]
    fn a_compressed_rollout_reads_as_its_plaintext() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("rollout-1.jsonl.zst");
        std::fs::write(&path, compress_to_vec(ROLLOUT, CompressionLevel::Fastest)).expect("write");
        assert!(is_compressed(&path));
        assert_eq!(read_source(&path).expect("decoded"), ROLLOUT);
        assert_eq!(read_head(&path, 8).expect("head"), &ROLLOUT[..8]);
    }

    #[test]
    fn a_plain_file_is_read_as_it_is() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("rollout-1.jsonl");
        std::fs::write(&path, ROLLOUT).expect("write");
        assert!(!is_compressed(&path));
        assert_eq!(read_source(&path).expect("read"), ROLLOUT);
    }

    #[test]
    fn the_archive_is_told_the_plain_name() {
        assert_eq!(
            logical_source_path("/s/rollout-1.jsonl.zst"),
            "/s/rollout-1.jsonl"
        );
        assert_eq!(
            logical_source_path("/s/rollout-1.jsonl"),
            "/s/rollout-1.jsonl"
        );
    }

    #[test]
    fn a_broken_frame_is_refused_and_skippable() {
        let error =
            decompress(Path::new("x.zst"), &b"not zstd at all"[..], 1024).expect_err("refused");
        assert!(matches!(error, DaemonError::Undecodable { .. }));
        assert!(error.is_skippable());
    }

    /// Decodes every `.jsonl.zst` under `MEMOAR_ZSTD_SWEEP_DIR` and prints the
    /// same total and digest `scripts/verify-store-sweep.mjs` prints with
    /// Node's decoder, so the two can be compared on a real store. Counts and
    /// hashes only.
    #[test]
    #[ignore = "reads a real store named by MEMOAR_ZSTD_SWEEP_DIR"]
    fn zstd_sweep() {
        use sha2::{Digest, Sha256};
        let Some(root) = std::env::var_os("MEMOAR_ZSTD_SWEEP_DIR") else {
            return;
        };
        let mut paths = Vec::new();
        let mut stack = vec![std::path::PathBuf::from(root)];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("readable").flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.to_string_lossy().ends_with(".jsonl.zst") {
                    paths.push(path.to_string_lossy().into_owned());
                }
            }
        }
        paths.sort();
        let (mut total, mut digest) = (0_u64, Sha256::new());
        for path in &paths {
            let file = std::fs::File::open(path).expect("open");
            let plain = decompress(Path::new(path), file, u64::MAX - 1).expect("decodes");
            total += plain.len() as u64;
            digest.update(Sha256::digest(&plain));
        }
        let hex = hex::encode(digest.finalize());
        println!(
            "{} files, {total} bytes, digest {}",
            paths.len(),
            &hex[..16]
        );
    }

    #[test]
    fn plaintext_past_the_ceiling_is_refused() {
        let big = vec![b'a'; 4096];
        let frame = compress_to_vec(&big[..], CompressionLevel::Fastest);
        let error = decompress(Path::new("x.zst"), &frame[..], 1024).expect_err("refused");
        assert!(matches!(error, DaemonError::TooLarge { .. }));
    }
}
