//! One extension in Goose's `config.yaml`.
//!
//! Goose writes this file itself, in block style, with each extension a map
//! under a top-level `extensions:` key. The edit works on lines: it finds that
//! key, replaces or appends memoar's block beneath it, and leaves every other
//! line alone. A file shaped differently, such as `extensions` in flow style,
//! is refused rather than guessed at.

use serde_json::Value;
use std::ops::Range;
use std::path::Path;

use crate::error::AppError;

pub(crate) fn install(
    path: &Path,
    text: Option<&str>,
    key: &str,
    name: &str,
    entry: &Value,
) -> Result<String, AppError> {
    let source = text.unwrap_or_default();
    let mut lines: Vec<String> = source.lines().map(str::to_owned).collect();
    let Some(section) = find_section(path, &lines, key)? else {
        lines.push(format!("{key}:"));
        lines.extend(render(name, entry, 2));
        return Ok(joined(&lines));
    };
    // `extensions: {}` becomes a block map that can hold an entry.
    if lines[section].contains("{}") {
        lines[section] = format!("{key}:");
    }
    let indent = child_indent(&lines, section);
    let block = render(name, entry, indent);
    match find_block(&lines, section, name, indent) {
        Some(range) if lines[range.clone()] == block[..] => Ok(source.to_owned()),
        Some(range) => {
            lines.splice(range, block);
            Ok(joined(&lines))
        }
        None => {
            lines.splice(section + 1..section + 1, block);
            Ok(joined(&lines))
        }
    }
}

pub(crate) fn uninstall(
    path: &Path,
    text: &str,
    key: &str,
    name: &str,
) -> Result<Option<String>, AppError> {
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    let Some(section) = find_section(path, &lines, key)? else {
        return Ok(None);
    };
    let indent = child_indent(&lines, section);
    let Some(range) = find_block(&lines, section, name, indent) else {
        return Ok(None);
    };
    lines.drain(range);
    Ok(Some(joined(&lines)))
}

/// Whether memoar's block is present, and whether it says what memoar would
/// write now.
pub(crate) fn current(text: &str, key: &str, name: &str, entry: &Value) -> Option<bool> {
    let lines: Vec<String> = text.lines().map(str::to_owned).collect();
    let section = find_section(Path::new(""), &lines, key).ok()??;
    let indent = child_indent(&lines, section);
    let range = find_block(&lines, section, name, indent)?;
    Some(lines[range] == render(name, entry, indent)[..])
}

/// The line holding `key:` at the top level. `key: {}` is rewritten to the
/// block form, since an empty map is the one flow value that is safe to read.
fn find_section(path: &Path, lines: &[String], key: &str) -> Result<Option<usize>, AppError> {
    let prefix = format!("{key}:");
    for (index, line) in lines.iter().enumerate() {
        let Some(rest) = line.strip_prefix(&prefix) else {
            continue;
        };
        let rest = rest.split('#').next().unwrap_or_default().trim();
        if rest.is_empty() || rest == "{}" {
            return Ok(Some(index));
        }
        return Err(AppError::local(
            format!(
                "{key} in {} is not a block map that memoar can edit",
                path.display()
            ),
            "Nothing was changed. Add the entry shown by --dry-run by hand, or run goose configure.",
        ));
    }
    Ok(None)
}

/// How far the existing entries are indented, or two spaces for the first.
fn child_indent(lines: &[String], section: usize) -> usize {
    lines[section + 1..]
        .iter()
        .find(|line| is_content(line))
        .map(|line| indent_of(line))
        .filter(|indent| *indent > 0)
        .unwrap_or(2)
}

/// The lines of the entry `name:` inside the section, from its key to the last
/// line indented deeper than it.
fn find_block(lines: &[String], section: usize, name: &str, indent: usize) -> Option<Range<usize>> {
    let key = format!("{}{name}:", " ".repeat(indent));
    let mut start = None;
    for (index, line) in lines.iter().enumerate().skip(section + 1) {
        if !is_content(line) {
            continue;
        }
        let depth = indent_of(line);
        if let Some(begin) = start {
            if depth <= indent {
                return Some(begin..trim_blank(lines, begin, index));
            }
            continue;
        }
        if depth == 0 {
            return None;
        }
        if line.trim_end() == key {
            start = Some(index);
        }
    }
    start.map(|begin| begin..trim_blank(lines, begin, lines.len()))
}

/// Pulls the end of a block back over trailing blank lines, which belong to
/// whatever follows.
fn trim_blank(lines: &[String], begin: usize, mut end: usize) -> usize {
    while end > begin + 1 && lines[end - 1].trim().is_empty() {
        end -= 1;
    }
    end
}

fn is_content(line: &str) -> bool {
    let trimmed = line.trim();
    !trimmed.is_empty() && !trimmed.starts_with('#')
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

/// The entry as block YAML. Scalars are written as JSON, which YAML reads as
/// the same values, so no string needs YAML's own quoting rules.
pub(crate) fn render(name: &str, entry: &Value, indent: usize) -> Vec<String> {
    let pad = " ".repeat(indent);
    let inner = " ".repeat(indent + 2);
    let mut lines = vec![format!("{pad}{name}:")];
    let Value::Object(fields) = entry else {
        return lines;
    };
    for (key, field) in fields {
        match field {
            Value::Array(items) if !items.is_empty() => {
                lines.push(format!("{inner}{key}:"));
                lines.extend(items.iter().map(|item| format!("{inner}  - {item}")));
            }
            Value::Object(map) if !map.is_empty() => {
                lines.push(format!("{inner}{key}:"));
                lines.extend(
                    map.iter()
                        .map(|(name, item)| format!("{inner}  {name}: {item}")),
                );
            }
            Value::Array(_) => lines.push(format!("{inner}{key}: []")),
            Value::Object(_) => lines.push(format!("{inner}{key}: {{}}")),
            scalar => lines.push(format!("{inner}{key}: {scalar}")),
        }
    }
    lines
}

fn joined(lines: &[String]) -> String {
    let mut text = lines.join("\n");
    text.push('\n');
    text
}
