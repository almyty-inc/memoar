//! Reading the CLI's JSON output.
//!
//! A field that is not there yields nothing rather than a zero, so the window
//! never shows a measurement nobody took.

use serde_json::Value;

fn at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cursor = value;
    for key in path {
        cursor = cursor.get(key)?;
    }
    Some(cursor)
}

pub(crate) fn number(value: &Value, path: &[&str]) -> Option<u64> {
    at(value, path)?.as_u64()
}

pub(crate) fn flag(value: &Value, path: &[&str]) -> Option<bool> {
    at(value, path)?.as_bool()
}

pub(crate) fn text(value: &Value, path: &[&str]) -> Option<String> {
    Some(at(value, path)?.as_str()?.to_owned())
}

/// The display names of the sources `memoar sources list` found on disk.
pub(crate) fn detected_sources(value: &Value) -> Vec<String> {
    value
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|item| item.get("detected").and_then(Value::as_bool) == Some(true))
                .filter_map(|item| {
                    item.get("displayName")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .collect()
        })
        .unwrap_or_default()
}
