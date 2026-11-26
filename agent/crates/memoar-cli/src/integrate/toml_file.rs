//! One server table in a TOML config, which is how Codex lists MCP servers.
//!
//! Edited with a format-preserving parser, so comments, ordering and every
//! other table come back as the person left them.

use serde_json::Value;
use std::path::Path;
use toml_edit::{Array, DocumentMut, Item, Table, value};

use crate::error::AppError;

pub(crate) fn install(
    path: &Path,
    text: Option<&str>,
    key: &str,
    name: &str,
    entry: &Value,
) -> Result<String, AppError> {
    let source = text.unwrap_or_default();
    let mut document = parse(path, source)?;
    let servers = document
        .entry(key)
        .or_insert_with(|| {
            let mut table = Table::new();
            // No bare `[mcp_servers]` header above the server's own table.
            table.set_implicit(true);
            Item::Table(table)
        })
        .as_table_like_mut()
        .ok_or_else(|| not_a_table(path, key))?;
    if servers.get(name).map(as_json) == Some(entry.clone()) {
        return Ok(source.to_owned());
    }
    servers.insert(name, Item::Table(table(entry)));
    Ok(document.to_string())
}

pub(crate) fn uninstall(
    path: &Path,
    text: &str,
    key: &str,
    name: &str,
) -> Result<Option<String>, AppError> {
    let mut document = parse(path, text)?;
    let Some(servers) = document.get_mut(key).and_then(Item::as_table_like_mut) else {
        return Ok(None);
    };
    if servers.remove(name).is_none() {
        return Ok(None);
    }
    Ok(Some(document.to_string()))
}

pub(crate) fn current(path: &Path, text: &str, key: &str, name: &str) -> Option<Value> {
    let document = parse(path, text).ok()?;
    document.get(key)?.as_table_like()?.get(name).map(as_json)
}

fn parse(path: &Path, text: &str) -> Result<DocumentMut, AppError> {
    text.parse::<DocumentMut>().map_err(|error| {
        AppError::local(
            format!("{} is not valid TOML: {error}", path.display()),
            "Nothing was changed. Fix the file, or add the entry shown by --dry-run by hand.",
        )
    })
}

fn not_a_table(path: &Path, key: &str) -> AppError {
    AppError::local(
        format!("{key} in {} is not a table", path.display()),
        "Nothing was changed. Fix the file, or add the entry shown by --dry-run by hand.",
    )
}

/// A server entry as a TOML table. Entries are flat: strings, string lists,
/// and one level of string maps such as `env`.
fn table(entry: &Value) -> Table {
    let mut table = Table::new();
    if let Value::Object(fields) = entry {
        for (key, field) in fields {
            match field {
                Value::String(text) => {
                    table.insert(key, value(text.as_str()));
                }
                Value::Bool(flag) => {
                    table.insert(key, value(*flag));
                }
                Value::Array(items) => {
                    let list: Array = items.iter().filter_map(Value::as_str).collect();
                    table.insert(key, value(list));
                }
                Value::Object(map) => {
                    let mut inline = toml_edit::InlineTable::new();
                    for (name, text) in map {
                        inline.insert(name, text.as_str().unwrap_or_default().into());
                    }
                    table.insert(key, value(inline));
                }
                Value::Null | Value::Number(_) => {}
            }
        }
    }
    table
}

/// Enough of TOML as JSON to tell whether an entry already says what memoar
/// would write.
fn as_json(item: &Item) -> Value {
    if let Some(table) = item.as_table_like() {
        return Value::Object(
            table
                .iter()
                .map(|(key, item)| (key.to_owned(), as_json(item)))
                .collect(),
        );
    }
    match item.as_value() {
        Some(toml_edit::Value::String(text)) => Value::String(text.value().clone()),
        Some(toml_edit::Value::Boolean(flag)) => Value::Bool(*flag.value()),
        Some(toml_edit::Value::Integer(number)) => Value::from(*number.value()),
        Some(toml_edit::Value::Array(items)) => Value::Array(
            items
                .iter()
                .map(|item| as_json(&Item::Value(item.clone())))
                .collect(),
        ),
        Some(toml_edit::Value::InlineTable(table)) => Value::Object(
            table
                .iter()
                .map(|(key, item)| (key.to_owned(), as_json(&Item::Value(item.clone()))))
                .collect(),
        ),
        _ => Value::Null,
    }
}
