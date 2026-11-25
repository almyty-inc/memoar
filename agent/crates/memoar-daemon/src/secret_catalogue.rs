//! Every credential shape the capture agent masks, in one table.
//!
//! The archive holds the same table in `server/src/secret-catalogue.ts`, and a
//! test on each side compares its table with
//! `server/test/fixtures/secret-scanner/catalogue.json`. The two scanners used
//! to be written separately. Each missed keys the other caught, and both missed
//! AWS, Google, GitLab, npm and most Slack tokens: an `AKIA…` key went up
//! unredacted under `--redact-secrets`.
//!
//! The rules for writing a pattern that V8 and this crate read the same way
//! are in the TypeScript file. The one that matters here is `\b`: V8 means the
//! ASCII word boundary, so [`compile`] asks this crate for that one too.

use std::sync::LazyLock;

use regex::{Regex, RegexBuilder};

/// What a match is filed as. The names are the archive's finding kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SecretKind {
    ApiKey,
    Jwt,
    PrivateKey,
    Credential,
    ConnectionString,
}

impl SecretKind {
    /// The archive's finding kind. Only the parity test reads it: the agent
    /// reports a count, and the archive files its own findings.
    #[cfg(test)]
    #[must_use]
    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::ApiKey => "api_key",
            Self::Jwt => "jwt",
            Self::PrivateKey => "private_key",
            Self::Credential => "credential",
            Self::ConnectionString => "connection_string",
        }
    }

    /// What replaces the secret in the artifact.
    ///
    /// These predate the table and are kept: a credential in a key/value pair
    /// has always read `[REDACTED]`, and the archive only needs to see that
    /// something was removed.
    #[must_use]
    pub(crate) const fn marker(self) -> &'static str {
        match self {
            Self::ApiKey => "[REDACTED_TOKEN]",
            Self::Jwt => "[REDACTED_JWT]",
            Self::PrivateKey => "[REDACTED_PRIVATE_KEY]",
            Self::Credential | Self::ConnectionString => "[REDACTED]",
        }
    }
}

#[derive(Debug)]
pub(crate) struct SecretRule {
    pub(crate) id: &'static str,
    pub(crate) kind: SecretKind,
    pub(crate) case_insensitive: bool,
    pub(crate) pattern: &'static str,
}

const fn rule(
    id: &'static str,
    kind: SecretKind,
    case_insensitive: bool,
    pattern: &'static str,
) -> SecretRule {
    SecretRule {
        id,
        kind,
        case_insensitive,
        pattern,
    }
}

use SecretKind::{ApiKey, ConnectionString, Credential, Jwt, PrivateKey};

/// In masking order. See the TypeScript table for why each rule is shaped as
/// it is: the two are held to the same fixture, so the reasons are written once.
pub(crate) const SECRET_CATALOGUE: &[SecretRule] = &[
    rule(
        "pem-private-key",
        PrivateKey,
        false,
        r#"-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----(?:(?:\r?\n|\\r?\\n)[A-Za-z][A-Za-z-]{0,31}: [A-Za-z0-9 ,.:;/+=()_-]{0,100}){0,4}[A-Za-z0-9+/=\\ \t\r\n]+-----END (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----"#,
    ),
    rule(
        "authorization-header",
        Credential,
        true,
        r#"(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?(?:(?:bearer|basic|token|digest)[ \t]+)?(?<secret>[^ \t\r\n\x0B\x0C"',;{}\[\]\\]+)"#,
    ),
    rule(
        "aws-access-key-id",
        ApiKey,
        false,
        r#"\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b"#,
    ),
    rule(
        "aws-secret-access-key",
        Credential,
        true,
        r#"(?:aws[A-Za-z0-9_.-]{0,20})?secret[_-]?access[_-]?key["']?[ \t]*[:=][ \t]*["']?(?<secret>[A-Za-z0-9/+=]{40,128})"#,
    ),
    rule("gcp-api-key", ApiKey, false, r#"\bAIza[A-Za-z0-9_-]{35}"#),
    rule(
        "google-oauth-client-secret",
        ApiKey,
        false,
        r#"\bGOCSPX-[A-Za-z0-9_-]{28}"#,
    ),
    rule(
        "azure-storage-key",
        ConnectionString,
        true,
        r#"(?:AccountKey|SharedAccessKey|SharedSecretValue)[ \t]*=[ \t]*(?<secret>[A-Za-z0-9+/]{20,256}={0,2})"#,
    ),
    rule(
        "azure-sas-signature",
        ConnectionString,
        false,
        r#"[?&;]sig=(?<secret>[A-Za-z0-9%+/=]{16,256})"#,
    ),
    rule(
        "azure-ad-client-secret",
        ApiKey,
        false,
        r#"\b[A-Za-z0-9_~.]{3}[78]Q~[A-Za-z0-9_~.-]{31,34}"#,
    ),
    rule(
        "github-token",
        ApiKey,
        false,
        r#"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b"#,
    ),
    rule(
        "github-fine-grained-pat",
        ApiKey,
        false,
        r#"\bgithub_pat_[A-Za-z0-9_]{22,255}\b"#,
    ),
    rule(
        "gitlab-token",
        ApiKey,
        false,
        r#"\bgl(?:pat|dt|ptt|rt|soat|cbt|imt|ffct|agent|oas)-[A-Za-z0-9_.-]{20,255}"#,
    ),
    rule(
        "slack-token",
        ApiKey,
        false,
        r#"\bxox(?:e\.xox[bp]|[abposre])-[A-Za-z0-9-]{10,255}"#,
    ),
    rule(
        "slack-app-token",
        ApiKey,
        false,
        r#"\bxapp-[0-9]{1,4}-[A-Za-z0-9-]{10,255}"#,
    ),
    rule(
        "slack-webhook",
        ApiKey,
        false,
        r#"hooks\.slack\.com/(?:services|workflows|triggers)/(?<secret>[A-Za-z0-9/_-]{20,255})"#,
    ),
    rule(
        "stripe-key",
        ApiKey,
        false,
        r#"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}\b"#,
    ),
    rule(
        "stripe-webhook-secret",
        ApiKey,
        false,
        r#"\bwhsec_[A-Za-z0-9]{24,255}\b"#,
    ),
    rule("npm-token", ApiKey, false, r#"\bnpm_[A-Za-z0-9]{36}\b"#),
    rule(
        "pypi-token",
        ApiKey,
        false,
        r#"\bpypi-AgE[A-Za-z0-9_-]{50,}"#,
    ),
    rule(
        "anthropic-key",
        ApiKey,
        false,
        r#"\bsk-ant-[a-z]{2,8}[0-9]{2}-[A-Za-z0-9_-]{20,255}"#,
    ),
    rule(
        "openai-key",
        ApiKey,
        false,
        r#"\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,255}"#,
    ),
    rule(
        "huggingface-token",
        ApiKey,
        false,
        r#"\bhf_[A-Za-z0-9]{30,255}\b"#,
    ),
    rule("twilio-api-key", ApiKey, false, r#"\bSK[0-9a-fA-F]{32}\b"#),
    rule(
        "twilio-auth-token",
        Credential,
        true,
        r#"twilio[A-Za-z0-9_.-]{0,30}token["']?[ \t]*[:=][ \t]*["']?(?<secret>[a-f0-9]{32})"#,
    ),
    rule(
        "sendgrid-key",
        ApiKey,
        false,
        r#"\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}"#,
    ),
    rule(
        "memoar-token",
        ApiKey,
        false,
        r#"\bmemoar_[A-Za-z0-9_-]{40,255}"#,
    ),
    rule(
        "generic-sk-key",
        ApiKey,
        false,
        r#"\bsk[_-][A-Za-z0-9_-]{16,255}"#,
    ),
    rule(
        "jwt",
        Jwt,
        false,
        r#"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"#,
    ),
    rule(
        "url-credentials",
        ConnectionString,
        true,
        r#"\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|clickhouse|cockroachdb|https?|s?ftp|smtps?|ldaps?|ssh|git)://[^:/@ \t\r\n"'\\\[\]]{0,256}:(?<secret>[^@/ \t\r\n"'\\\[\]]{1,256})@"#,
    ),
    rule(
        "generic-assignment",
        Credential,
        true,
        r#"\b[A-Za-z0-9_.-]{0,64}(?:api[_-]?key|access[_-]?key|(?:auth|access|refresh|bearer|session|api|bot|npm|github|gitlab|gh|slack|hf|pypi)[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret)[A-Za-z0-9_.-]{0,40}["']?[ \t]*[:=][ \t]*["']?(?<secret>[^ \t\r\n\x0B\x0C"',;{}\[\]\\]+)"#,
    ),
];

pub(crate) struct CompiledRule {
    pub(crate) rule: &'static SecretRule,
    pub(crate) regex: Regex,
}

/// Compiled once per process. These used to be compiled on every artifact.
pub(crate) static COMPILED_CATALOGUE: LazyLock<Vec<CompiledRule>> = LazyLock::new(|| {
    SECRET_CATALOGUE
        .iter()
        .map(|rule| CompiledRule {
            rule,
            regex: compile(rule),
        })
        .collect()
});

/// Builds one rule for this engine.
///
/// `\b` becomes `(?-u:\b)`. This crate's `\b` is Unicode-aware and V8's is
/// not, so `éAKIA…` was a key to the archive and a word to the agent. No
/// pattern in the table contains an escaped backslash followed by `b`, which is
/// the only text this rewrite could misread, and a test holds it to that.
pub(crate) fn compile(rule: &SecretRule) -> Regex {
    RegexBuilder::new(&rule.pattern.replace(r"\b", r"(?-u:\b)"))
        .case_insensitive(rule.case_insensitive)
        .build()
        .unwrap_or_else(|error| panic!("secret rule {} must compile: {error}", rule.id))
}
