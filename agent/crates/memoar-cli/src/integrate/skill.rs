//! The `memoar-memory` skill, as this binary ships it.
//!
//! The files are compiled in from `skill/` at the repository root, so the skill
//! an agent receives always describes the commands of the binary that
//! installed it.

use std::fs;
use std::path::Path;

use super::write::{FileOp, read_existing};
use crate::error::AppError;

pub(crate) const SKILL_NAME: &str = "memoar-memory";

/// Each file's path inside the skill directory, and its text.
pub(crate) const SKILL_FILES: [(&str, &str); 3] = [
    ("SKILL.md", include_str!("../../../../../skill/SKILL.md")),
    (
        "references/robot-api.md",
        include_str!("../../../../../skill/references/robot-api.md"),
    ),
    (
        "agents/openai.yaml",
        include_str!("../../../../../skill/agents/openai.yaml"),
    ),
];

/// Writes the skill into `skills/memoar-memory`. A file that already matches
/// is left alone, and one somebody edited is backed up before it is replaced.
pub(crate) fn plan_install(skills: &Path) -> Result<Vec<FileOp>, AppError> {
    let root = skills.join(SKILL_NAME);
    SKILL_FILES
        .iter()
        .map(|(relative, text)| {
            let path = root.join(relative);
            Ok(FileOp::Write {
                previous: read_existing(&path)?,
                path,
                next: (*text).to_owned(),
                removing: false,
            })
        })
        .collect()
}

/// Removes the files the skill consists of. Anything else somebody put in
/// that directory stays, and so does the directory then.
pub(crate) fn plan_uninstall(skills: &Path) -> Vec<FileOp> {
    let root = skills.join(SKILL_NAME);
    SKILL_FILES
        .iter()
        .map(|(relative, _)| {
            let path = root.join(relative);
            FileOp::Delete {
                present: path.is_file(),
                path,
            }
        })
        .collect()
}

/// Removes the skill's directories once its files are gone. A directory that
/// still holds something is left, which is what `remove_dir` does anyway.
pub(crate) fn remove_empty_directories(skills: &Path) {
    let root = skills.join(SKILL_NAME);
    for directory in [root.join("references"), root.join("agents"), root] {
        let _ = fs::remove_dir(directory);
    }
}

/// Whether the skill is there, and whether it is this binary's version.
pub(crate) fn status(skills: &Path) -> (bool, bool) {
    let root = skills.join(SKILL_NAME);
    let mut present = false;
    let mut current = true;
    for (relative, text) in SKILL_FILES {
        match fs::read_to_string(root.join(relative)) {
            Ok(found) => {
                present = true;
                current &= found == text;
            }
            Err(_) => current = false,
        }
    }
    (present, present && current)
}
