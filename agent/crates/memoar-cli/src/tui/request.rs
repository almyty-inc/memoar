//! What the TUI asks for, and what comes back.
//!
//! Keys never call the archive. They return a `Request`, the loop runs it off
//! the drawing thread, and the answer comes back as a `Response` for `update`.
//! A test asserts on the requests without any network at all.

use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Request {
    /// A page of `GET /sessions`. `None` is the first page and replaces the list.
    Sessions {
        cursor: Option<String>,
    },
    Machines,
    /// A chunk of `memoar view`.
    Transcript {
        session_id: String,
        cursor: Option<String>,
    },
    /// `memoar search`. `cursor` pages through the same query.
    Search {
        query: String,
        cursor: Option<String>,
    },
    /// What `memoar status` reports.
    Status,
    /// `memoar convert --here`: fetch a native bundle and write it here, never
    /// over a file that differs.
    Convert {
        session_id: String,
        target: String,
    },
    /// Write the canonical export into the working directory.
    Export {
        session_id: String,
    },
    /// Put text on the clipboard. Runs on the drawing thread, as one way of
    /// doing it is an escape sequence written to the terminal.
    Copy {
        text: String,
    },
}

#[derive(Debug)]
pub(crate) enum Response {
    Sessions {
        cursor: Option<String>,
        result: Result<Value, AppError>,
    },
    Machines(Result<HashMap<String, String>, AppError>),
    Transcript {
        session_id: String,
        cursor: Option<String>,
        result: Result<Value, AppError>,
    },
    Search {
        query: String,
        cursor: Option<String>,
        result: Result<Value, AppError>,
    },
    Status(Result<Value, AppError>),
    Converted {
        session_id: String,
        target: String,
        result: Result<Value, AppError>,
    },
    Exported {
        session_id: String,
        result: Result<PathBuf, AppError>,
    },
    Copied {
        text: String,
        result: Result<String, String>,
    },
}
