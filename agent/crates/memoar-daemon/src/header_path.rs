//! The capture path as it travels in the `x-memoar-source-path` header.
//!
//! A header value is bytes, and the server read them as latin1, so a path with
//! `ü` or `日本` in it was archived as mojibake. The contract now says the value
//! is percent-encoded UTF-8: every byte outside the RFC 3986 unreserved set is
//! written as `%XX`, path separators included. That keeps the header plain
//! ASCII, and because a raw path always contains a separator, the server can
//! tell an encoded value from one sent by an older agent.

/// Percent-encodes every byte of `path` that is not unreserved.
pub(crate) fn encode_source_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::encode_source_path;

    #[test]
    fn encodes_non_ascii_as_utf8_bytes() {
        assert_eq!(
            encode_source_path("/Users/ünï 日本/x.jsonl"),
            "%2FUsers%2F%C3%BCn%C3%AF%20%E6%97%A5%E6%9C%AC%2Fx.jsonl"
        );
    }

    #[test]
    fn encodes_separators_and_percent_so_no_raw_path_looks_encoded() {
        assert_eq!(
            encode_source_path(r"C:\a b\100%.jsonl"),
            "C%3A%5Ca%20b%5C100%25.jsonl"
        );
    }

    #[test]
    fn keeps_unreserved_characters() {
        assert_eq!(encode_source_path("AZaz09-._~"), "AZaz09-._~");
    }
}
