//! Fitting text into terminal columns by display width, not bytes or chars.

use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

pub(crate) fn width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

/// The text cut to `max` columns, with an ellipsis when anything was cut.
pub(crate) fn truncate(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_owned();
    }
    let ellipsis = super::style::glyphs().ellipsis;
    let room = max.saturating_sub(width(ellipsis));
    let mut out = String::new();
    let mut used = 0;
    for character in text.chars() {
        let size = character.width().unwrap_or(0);
        if used + size > room {
            break;
        }
        out.push(character);
        used += size;
    }
    if max >= width(ellipsis) {
        out.push_str(ellipsis);
    }
    out
}

/// The text padded with spaces, or cut, to exactly `columns`.
pub(crate) fn fit(text: &str, columns: usize) -> String {
    let mut out = truncate(text, columns);
    let used = width(&out);
    out.extend(std::iter::repeat_n(' ', columns.saturating_sub(used)));
    out
}

/// The first line of the text, with surrounding space removed.
pub(crate) fn first_line(text: &str) -> &str {
    text.trim().lines().next().unwrap_or_default().trim()
}
