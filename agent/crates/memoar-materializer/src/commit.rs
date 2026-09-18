//! Staging every planned file, then linking them in, or rolling all of it back.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::bundle::PlannedFile;
use crate::error::MaterializeError;
use crate::paths::{create_safe_parent, verify_safe_ancestors};

pub(crate) fn commit_plan(
    home: &Path,
    planned: &[PlannedFile],
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), MaterializeError> {
    commit_plan_with_hook(home, planned, |_| Ok(()))
}

pub(crate) fn commit_plan_with_hook<F>(
    home: &Path,
    planned: &[PlannedFile],
    mut before_commit: F,
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), MaterializeError>
where
    F: FnMut(usize) -> Result<(), std::io::Error>,
{
    let mut unchanged = Vec::new();
    for file in planned {
        verify_safe_ancestors(home, &file.path)?;
        match fs::symlink_metadata(&file.path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(MaterializeError::Collision(file.path.clone()));
            }
            Ok(_) => {
                let existing = fs::read(&file.path).map_err(|source| MaterializeError::Io {
                    path: file.path.clone(),
                    source,
                })?;
                if existing == file.bytes {
                    unchanged.push(file.path.clone());
                } else {
                    return Err(MaterializeError::Collision(file.path.clone()));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(MaterializeError::Io {
                    path: file.path.clone(),
                    source,
                });
            }
        }
    }

    let mut staged = Vec::new();
    for file in planned {
        if unchanged.contains(&file.path) {
            continue;
        }
        create_safe_parent(home, &file.path)?;
        let parent = file
            .path
            .parent()
            .ok_or_else(|| MaterializeError::UnsafePath(file.path.display().to_string()))?;
        let temporary = parent.join(format!(".memoar-{}.tmp", Uuid::now_v7()));
        let stage_result = (|| -> Result<(), std::io::Error> {
            let mut handle = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temporary)?;
            handle.write_all(&file.bytes)?;
            handle.sync_all()
        })();
        if let Err(source) = stage_result {
            let _ = fs::remove_file(&temporary);
            for (_, temporary) in &staged {
                let _ = fs::remove_file(temporary);
            }
            return Err(MaterializeError::Io {
                path: file.path.clone(),
                source,
            });
        }
        staged.push((file.path.clone(), temporary));
    }

    let mut written = Vec::new();
    for (index, (target, temporary)) in staged.iter().enumerate() {
        let result = before_commit(index).and_then(|()| fs::hard_link(temporary, target));
        if let Err(source) = result {
            for created in written.iter().rev() {
                let _ = fs::remove_file(created);
            }
            for (_, temporary) in &staged {
                let _ = fs::remove_file(temporary);
            }
            return Err(if source.kind() == std::io::ErrorKind::AlreadyExists {
                MaterializeError::Collision(target.clone())
            } else {
                MaterializeError::Io {
                    path: target.clone(),
                    source,
                }
            });
        }
        written.push(target.clone());
    }
    for (_, temporary) in &staged {
        let _ = fs::remove_file(temporary);
    }
    Ok((written, unchanged))
}
