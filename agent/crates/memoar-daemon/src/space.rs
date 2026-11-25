//! The disk guard: how much room the queue's volume has, and the floor it keeps.
//!
//! A first sync on a machine with 58 GB of sessions copied every file into the
//! queue before uploading one, and stopped with the disk at 99%. The queue no
//! longer copies what it can read back from the source, but redacted content
//! and database snapshots are still written, and so is the queue itself. So
//! capture checks the volume before it writes and refuses to go below a floor.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::error::DaemonError;

const GIB: u64 = 1024 * 1024 * 1024;

/// How much free space capture leaves alone.
///
/// The default is 5% of the volume, kept between 2 GiB and 10 GiB. A flat 5%
/// of a 1 TB disk is 46 GiB, which would stop capture on a laptop with 15 GiB
/// free while that laptop has plenty of room for a queue of metadata. Below
/// 2 GiB the system itself starts failing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceFloor {
    /// An exact floor in bytes, set by the user. Replaces the default rule.
    pub min_free_bytes: Option<u64>,
}

impl SpaceFloor {
    #[must_use]
    pub const fn default_rule() -> Self {
        Self {
            min_free_bytes: None,
        }
    }

    #[must_use]
    pub const fn exact(bytes: u64) -> Self {
        Self {
            min_free_bytes: Some(bytes),
        }
    }

    /// The floor in bytes for a volume of `total` bytes.
    #[must_use]
    pub fn bytes_for(&self, total: u64) -> u64 {
        if let Some(bytes) = self.min_free_bytes {
            return bytes;
        }
        (total / 20).clamp(2 * GIB, 10 * GIB)
    }
}

impl Default for SpaceFloor {
    fn default() -> Self {
        Self::default_rule()
    }
}

/// One measurement of the volume against the floor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceCheck {
    pub path: PathBuf,
    pub available_bytes: u64,
    pub total_bytes: u64,
    pub floor_bytes: u64,
    pub ok: bool,
}

/// Measures the volume `dir` is on, or would be on once created, against
/// `floor`, as if `needed` more bytes were about to be written.
pub fn check_space(dir: &Path, floor: SpaceFloor, needed: u64) -> Result<SpaceCheck, DaemonError> {
    let existing = nearest_existing(dir);
    let (available, total) = volume_space(&existing).map_err(|source| DaemonError::Io {
        path: existing.clone(),
        source,
    })?;
    let floor_bytes = floor.bytes_for(total);
    Ok(SpaceCheck {
        path: dir.to_path_buf(),
        available_bytes: available,
        total_bytes: total,
        floor_bytes,
        ok: available >= floor_bytes.saturating_add(needed),
    })
}

/// The same measurement, as a refusal when it fails.
pub fn ensure_space(dir: &Path, floor: SpaceFloor, needed: u64) -> Result<SpaceCheck, DaemonError> {
    let check = check_space(dir, floor, needed)?;
    if check.ok {
        return Ok(check);
    }
    Err(DaemonError::DiskLow {
        path: check.path,
        available: check.available_bytes,
        floor: check.floor_bytes,
        needed,
    })
}

/// The data directory may not exist yet on a first run, and asking about a
/// missing path fails. Its closest existing ancestor is on the same volume
/// unless a mount point sits in between, which a fresh data directory never has.
fn nearest_existing(dir: &Path) -> PathBuf {
    let mut candidate = dir;
    loop {
        if candidate.exists() {
            return candidate.to_path_buf();
        }
        match candidate.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => candidate = parent,
            _ => return PathBuf::from("."),
        }
    }
}

/// Bytes available to this user, and the size of the volume.
#[cfg(unix)]
fn volume_space(path: &Path) -> std::io::Result<(u64, u64)> {
    let stats = rustix::fs::statvfs(path)?;
    let block = stats.f_frsize.max(1);
    Ok((
        stats.f_bavail.saturating_mul(block),
        stats.f_blocks.saturating_mul(block),
    ))
}

#[cfg(windows)]
fn volume_space(path: &Path) -> std::io::Result<(u64, u64)> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let mut available = 0_u64;
    let mut total = 0_u64;
    let mut free = 0_u64;
    // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call,
    // and the three out-pointers are valid, aligned u64s owned by this frame.
    // windows-sys offers no safe wrapper for this API, which is the reason
    // this crate has an unsafe block at all.
    #[allow(unsafe_code)]
    let succeeded =
        unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    if succeeded == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((available, total))
}

#[cfg(not(any(unix, windows)))]
fn volume_space(_path: &Path) -> std::io::Result<(u64, u64)> {
    Ok((u64::MAX, u64::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_floor_is_five_percent_kept_between_two_and_ten_gib() {
        let floor = SpaceFloor::default();
        assert_eq!(
            floor.bytes_for(10 * GIB),
            2 * GIB,
            "a small disk keeps 2 GiB"
        );
        assert_eq!(floor.bytes_for(100 * GIB), 5 * GIB);
        assert_eq!(
            floor.bytes_for(1000 * GIB),
            10 * GIB,
            "a large disk keeps 10 GiB"
        );
        assert_eq!(SpaceFloor::exact(7).bytes_for(1000 * GIB), 7);
    }

    #[test]
    fn a_floor_past_the_free_space_is_refused_with_the_numbers() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("not/yet/created");
        let check = check_space(&missing, SpaceFloor::exact(0), 0).unwrap();
        assert!(check.ok && check.available_bytes > 0);
        let error = ensure_space(&missing, SpaceFloor::exact(u64::MAX / 2), 0).unwrap_err();
        assert!(matches!(error, DaemonError::DiskLow { .. }), "{error}");
    }
}
