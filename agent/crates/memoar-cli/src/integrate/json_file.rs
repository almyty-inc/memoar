//! One server entry in a JSON or JSONC settings file.
//!
//! Zed and VS Code settings files carry comments and trailing commas, and a
//! person's comments are part of their file. The edit goes through a concrete
//! syntax tree, so everything outside memoar's own entry comes back byte for
//! byte as it was.

use jsonc_parser::ParseOptions;
use jsonc_parser::cst::{CstInputValue, CstObject, CstRootNode};
use serde_json::Value;
use std::path::Path;

use crate::error::AppError;

/// The file with `entry` under `keys` then `name`, or the same text when it
/// already says that.
pub(crate) fn install(
    path: &Path,
    text: Option<&str>,
    keys: &[&str],
    name: &str,
    entry: &Value,
) -> Result<String, AppError> {
    let source = match text {
        Some(text) if !text.trim().is_empty() => text,
        _ => "{}\n",
    };
    let root = parse(path, source)?;
    let mut object = root_object(path, &root)?;
    for key in keys {
        object = child_object(path, &object, key)?;
    }
    match object.get(name) {
        Some(existing) => {
            let current = existing.value().and_then(|value| value.to_serde_value());
            if current.as_ref() == Some(entry) {
                return Ok(source.to_owned());
            }
            existing.set_value(input(entry));
        }
        None => {
            object.append(name, input(entry));
        }
    }
    Ok(root.to_string())
}

/// The file without memoar's entry, or `None` when it has none.
pub(crate) fn uninstall(
    path: &Path,
    text: &str,
    keys: &[&str],
    name: &str,
) -> Result<Option<String>, AppError> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    let root = parse(path, text)?;
    let Some(mut object) = root.object_value() else {
        return Ok(None);
    };
    for key in keys {
        let Some(child) = object.object_value(key) else {
            return Ok(None);
        };
        object = child;
    }
    let Some(entry) = object.get(name) else {
        return Ok(None);
    };
    entry.remove();
    Ok(Some(root.to_string()))
}

/// The entry memoar would find under `keys` then `name`, for `status`.
pub(crate) fn current(path: &Path, text: &str, keys: &[&str], name: &str) -> Option<Value> {
    let root = parse(path, text).ok()?;
    let mut object = root.object_value()?;
    for key in keys {
        object = object.object_value(key)?;
    }
    object.get(name)?.value()?.to_serde_value()
}

fn parse(path: &Path, text: &str) -> Result<CstRootNode, AppError> {
    CstRootNode::parse(text, &ParseOptions::default()).map_err(|error| {
        AppError::local(
            format!("{} is not valid JSON: {error}", path.display()),
            "Nothing was changed. Fix the file, or add the entry shown by --dry-run by hand.",
        )
    })
}

fn root_object(path: &Path, root: &CstRootNode) -> Result<CstObject, AppError> {
    match root.value() {
        None => Ok(root.object_value_or_set()),
        Some(value) => value
            .as_object()
            .ok_or_else(|| not_an_object(path, "the file")),
    }
}

/// The object under `key`, created when absent. A value of another kind is
/// somebody's setting, and replacing it would be clobbering it.
fn child_object(path: &Path, parent: &CstObject, key: &str) -> Result<CstObject, AppError> {
    match parent.get(key) {
        None => Ok(parent.object_value_or_set(key)),
        Some(property) => property
            .value()
            .and_then(|value| value.as_object())
            .ok_or_else(|| not_an_object(path, key)),
    }
}

fn not_an_object(path: &Path, what: &str) -> AppError {
    AppError::local(
        format!("{what} in {} is not a JSON object", path.display()),
        "Nothing was changed. Fix the file, or add the entry shown by --dry-run by hand.",
    )
}

fn input(value: &Value) -> CstInputValue {
    match value {
        Value::Null => CstInputValue::Null,
        Value::Bool(flag) => CstInputValue::Bool(*flag),
        Value::Number(number) => CstInputValue::Number(number.to_string()),
        Value::String(text) => CstInputValue::String(text.clone()),
        Value::Array(items) => CstInputValue::Array(items.iter().map(input).collect()),
        Value::Object(fields) => CstInputValue::Object(
            fields
                .iter()
                .map(|(key, value)| (key.clone(), input(value)))
                .collect(),
        ),
    }
}
