//! Where a bundle file is allowed to land, and the ancestors it may cross.

use std::path::{Component, Path, PathBuf};

use crate::error::MaterializeError;
use crate::target::Target;
use std::fs;

pub(crate) fn resolve_bundle_path(
    home: &Path,
    wire_path: &str,
    target: Target,
    session_id: &str,
) -> Result<PathBuf, MaterializeError> {
    let relative = wire_path
        .strip_prefix("~/")
        .ok_or_else(|| MaterializeError::UnsafePath(wire_path.to_owned()))?;
    let relative_path = Path::new(relative);
    if relative_path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) | Component::CurDir
        )
    }) {
        return Err(MaterializeError::UnsafePath(wire_path.to_owned()));
    }
    let normalized = relative_path.to_string_lossy();
    let allowed_prefix = match target {
        Target::ClaudeCode => ".claude/projects/",
        Target::Codex => ".codex/sessions/",
        Target::AntigravityCli => ".gemini/antigravity-cli/brain/",
    };
    if !normalized.starts_with(allowed_prefix) || !normalized.contains(session_id) {
        return Err(MaterializeError::UnsafePath(wire_path.to_owned()));
    }
    Ok(home.join(relative_path))
}

pub(crate) fn verify_safe_ancestors(home: &Path, path: &Path) -> Result<(), MaterializeError> {
    let relative = path
        .strip_prefix(home)
        .map_err(|_| MaterializeError::UnsafePath(path.display().to_string()))?;
    let mut current = home.to_path_buf();
    for component in relative
        .components()
        .take(relative.components().count().saturating_sub(1))
    {
        let Component::Normal(name) = component else {
            return Err(MaterializeError::UnsafePath(path.display().to_string()));
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(MaterializeError::UnsafePath(current.display().to_string()));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(MaterializeError::Io {
                    path: current,
                    source,
                });
            }
        }
    }
    Ok(())
}

pub(crate) fn create_safe_parent(home: &Path, path: &Path) -> Result<(), MaterializeError> {
    let parent = path
        .parent()
        .ok_or_else(|| MaterializeError::UnsafePath(path.display().to_string()))?;
    let relative = parent
        .strip_prefix(home)
        .map_err(|_| MaterializeError::UnsafePath(path.display().to_string()))?;
    if !home.exists() {
        fs::create_dir(home).map_err(|source| MaterializeError::Io {
            path: home.to_path_buf(),
            source,
        })?;
    }
    let mut current = home.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(MaterializeError::UnsafePath(path.display().to_string()));
        };
        current.push(name);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let metadata =
                    fs::symlink_metadata(&current).map_err(|source| MaterializeError::Io {
                        path: current.clone(),
                        source,
                    })?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(MaterializeError::UnsafePath(current.display().to_string()));
                }
            }
            Err(source) => {
                return Err(MaterializeError::Io {
                    path: current,
                    source,
                });
            }
        }
    }
    Ok(())
}
