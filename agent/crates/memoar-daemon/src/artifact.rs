//! Redacting a whole artifact file, including the ZIP containers.

use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use crate::error::DaemonError;
use crate::redaction::{
    RedactedBytes, RedactionConfig, contains_secret_lossy, contains_secret_utf16, looks_like_utf16,
    redact_bytes,
};

pub(crate) fn redact_artifact(
    path: &Path,
    bytes: &[u8],
    config: RedactionConfig,
) -> Result<RedactedBytes, DaemonError> {
    if !config.enabled() {
        return Ok(RedactedBytes {
            bytes: bytes.to_vec(),
            replacements: 0,
            scanned: true,
        });
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(
        extension.as_str(),
        "db" | "sqlite" | "sqlite3" | "pb" | "protobuf"
    ) {
        return Err(DaemonError::UnsupportedRedaction(path.to_path_buf()));
    }
    if extension == "zip" {
        return redact_zip(path, bytes, config);
    }
    let redacted = redact_bytes(bytes, config);
    // Text stored two bytes to the character defeats the check below, because
    // it is valid UTF-8: every other byte is a NUL, which is a legal code
    // point, so the artifact is reported scanned while no pattern could match
    // across the NULs. Decoding it is only ever used to refuse — rewriting
    // UTF-16 in place is not something this does.
    if redacted.replacements == 0 && looks_like_utf16(bytes) && contains_secret_utf16(bytes, config)
    {
        return Err(DaemonError::UnscannableSecret {
            path: path.to_path_buf(),
        });
    }
    if !redacted.scanned && contains_secret_lossy(bytes, config) {
        // The bytes are not valid UTF-8, so no pattern could be applied to
        // them, and a lossy read shows something that should have been
        // removed. Rewriting a lossy view would corrupt the artifact, so this
        // refuses it the same way an opaque database is refused. Silently
        // uploading an unscanned file is the one outcome redaction must not
        // have.
        return Err(DaemonError::UnscannableSecret {
            path: path.to_path_buf(),
        });
    }
    Ok(redacted)
}

fn redact_zip(
    path: &Path,
    bytes: &[u8],
    config: RedactionConfig,
) -> Result<RedactedBytes, DaemonError> {
    const MAX_ENTRIES: usize = 4096;
    const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
    const MAX_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

    let cursor = Cursor::new(bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|error| DaemonError::Zip {
        path: path.to_path_buf(),
        message: error.to_string(),
    })?;
    if archive.len() > MAX_ENTRIES {
        return Err(DaemonError::Zip {
            path: path.to_path_buf(),
            message: format!("archive exceeds {MAX_ENTRIES} entries"),
        });
    }
    let output = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(output);
    let mut replacements = 0_u32;
    let mut total = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| DaemonError::Zip {
            path: path.to_path_buf(),
            message: error.to_string(),
        })?;
        let name = entry.name().to_owned();
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(entry.compression())
            .unix_permissions(entry.unix_mode().unwrap_or(0o600));
        if entry.is_dir() {
            writer
                .add_directory(name, options)
                .map_err(|error| DaemonError::Zip {
                    path: path.to_path_buf(),
                    message: error.to_string(),
                })?;
            continue;
        }
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(DaemonError::Zip {
                path: path.to_path_buf(),
                message: format!("entry {name} exceeds size limit"),
            });
        }
        total = total.saturating_add(entry.size());
        if total > MAX_TOTAL_BYTES {
            return Err(DaemonError::Zip {
                path: path.to_path_buf(),
                message: "archive exceeds total uncompressed size limit".to_owned(),
            });
        }
        let virtual_path = Path::new(&name);
        let extension = virtual_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if matches!(
            extension.as_str(),
            "db" | "sqlite" | "sqlite3" | "pb" | "protobuf" | "zip"
        ) {
            return Err(DaemonError::UnsupportedRedaction(PathBuf::from(format!(
                "{}::{name}",
                path.display()
            ))));
        }
        let mut entry_bytes = Vec::new();
        entry
            .read_to_end(&mut entry_bytes)
            .map_err(|source| DaemonError::Io {
                path: PathBuf::from(format!("{}::{name}", path.display())),
                source,
            })?;
        let redacted = redact_bytes(&entry_bytes, config);
        if !redacted.scanned && contains_secret_lossy(&entry_bytes, config) {
            // The same refusal the top level makes, for the same reason. This
            // branch only looked at `.replacements`, so an entry that could not
            // be read as text was repacked exactly as found and shipped with
            // `redacted: false` — a member of an archive was the one place an
            // unscanned secret could still get out.
            return Err(DaemonError::UnscannableSecret {
                path: PathBuf::from(format!("{}::{name}", path.display())),
            });
        }
        replacements = replacements.saturating_add(redacted.replacements);
        writer
            .start_file(name, options)
            .map_err(|error| DaemonError::Zip {
                path: path.to_path_buf(),
                message: error.to_string(),
            })?;
        writer
            .write_all(&redacted.bytes)
            .map_err(|source| DaemonError::Io {
                path: path.to_path_buf(),
                source,
            })?;
    }
    if replacements == 0 {
        return Ok(RedactedBytes {
            bytes: bytes.to_vec(),
            replacements: 0,
            scanned: true,
        });
    }
    let bytes = writer
        .finish()
        .map_err(|error| DaemonError::Zip {
            path: path.to_path_buf(),
            message: error.to_string(),
        })?
        .into_inner();
    Ok(RedactedBytes {
        bytes,
        replacements,
        scanned: true,
    })
}
