# Releasing Memoar

A release is one workflow, `.github/workflows/release.yml`. Pushing a `v*` tag
builds, signs, verifies and publishes a GitHub Release. A manual dispatch does
only what its inputs switch on, so a dispatch with `build_binaries` alone is a
dry run that publishes nothing. The npm launcher is published separately, by a
dispatch with `publish_npm`.

Nothing in this repository can publish by accident, and two steps cannot be
undone: a public release tag, and an npm version.

## What a release contains

| File | What it is |
| --- | --- |
| `memoar-aarch64-apple-darwin`, `memoar-x86_64-apple-darwin` | macOS CLI, Apple silicon and Intel |
| `memoar-x86_64-unknown-linux-gnu`, `memoar-aarch64-unknown-linux-gnu` | Linux CLI, needs glibc 2.28 or newer |
| `memoar-x86_64-unknown-linux-musl`, `memoar-aarch64-unknown-linux-musl` | Linux CLI, static, for Alpine and other musl systems |
| `memoar-x86_64-pc-windows-msvc.exe`, `memoar-aarch64-pc-windows-msvc.exe` | Windows CLI, x64 and ARM64, C runtime linked in |
| `memoar-desktop-<v>-macos-arm64.dmg` | Desktop app for macOS, when packaged |
| `memoar-desktop-<v>-linux-x64.tar.gz` | Desktop app for Linux (GTK 4), when packaged |
| `memoar-desktop-<v>-windows-x64.zip` | Desktop app for Windows, when packaged |
| `<file>.sha256` | One per binary or package. The npm launcher and both installers read it |
| `SHA256SUMS` | Every file above in `sha256sum -c` format |
| `memoar-<v>.spdx.json` | SPDX SBOM of the Rust workspace, from `Cargo.lock` |
| `memoar.rb` | Homebrew formula pinned to this release's checksums |
| `install.sh`, `install.ps1` | The installers, so `releases/latest/download/install.sh` always works |

Every file listed in `SHA256SUMS` also gets a build provenance attestation,
checked with `gh attestation verify <file> --repo almyty-inc/memoar`.

The asset names are not free-form. `packages/npx/lib/platform.js` computes the
name it downloads, and the release fails when any platform the launcher offers
has no asset.

## What the workflow does

1. **Plan.** Decides which jobs run and checks versions with
   `scripts/release/check-versions.mjs`. When binaries are built, the version
   (from the tag, the `version` input, or `agent/Cargo.toml`) must equal the
   workspace version in `agent/Cargo.toml`, the `memoar-cli` entry in
   `agent/Cargo.lock`, and `AGENT_VERSION` in `packages/npx/lib/platform.js`.
   When npm is published, it must equal `packages/npx/package.json`.
2. **cli.** Eight native builds. Each binary must print `memoar <version>`.
   Linux builds use `cargo zigbuild` against glibc 2.28 and run in Rocky
   Linux 8 or Alpine before they are accepted. Builds set `SOURCE_DATE_EPOCH`
   from the commit, `--locked`, and remap the checkout path.
3. **Sign.** macOS binaries are signed with a Developer ID and notarized.
   Windows binaries are signed with Azure Trusted Signing or a certificate
   file. Linux binaries are not signed. See [Signing](#signing).
4. **desktop.** Runs `agent/scripts/package-desktop.sh` on macOS, Linux and
   Windows. See [The desktop packaging contract](#the-desktop-packaging-contract).
5. **assemble.** Collects everything, writes `SHA256SUMS`, the SBOM, the
   formula and the release notes, and fails if a launcher platform is missing.
6. **verify.** On Ubuntu, macOS and Windows, serves the unpublished files over
   local HTTP and installs them through the npm launcher, `install.sh` (also in
   Alpine and Rocky Linux 8 containers), the Homebrew formula, and
   `install.ps1` under PowerShell 7, Windows PowerShell 5.1 and `irm | iex`.
7. **release.** Attests provenance and publishes the GitHub Release. Runs in
   the `release` environment.
8. **npm.** Publishes the launcher with npm trusted publishing. It waits for
   the release when the same run publishes one.

## Dry run

Run this before every release, and after any change to the workflow:

```sh
gh workflow run release.yml --ref <branch> -f build_binaries=true -f build_desktop=true
gh run watch "$(gh run list --workflow release.yml --branch <branch> -L 1 --json databaseId -q '.[0].databaseId')"
```

It builds, signs (with whatever secrets exist), assembles and verifies. The
`release` and `npm` jobs are skipped. The run summary lists every file, its
checksum and its signing status. The assembled files are in the
`release-files` artifact of the run.

## Cutting a release

1. Pick the version, for example `0.4.0`. Then, in one pull request:
   - set `version` under `[workspace.package]` in `agent/Cargo.toml`
   - run `cargo check --manifest-path agent/Cargo.toml` so `agent/Cargo.lock` follows
   - set `AGENT_VERSION` in `packages/npx/lib/platform.js`
   - set `version` in `packages/npx/package.json` if the launcher ships too
   - run `npm test` in `packages/npx` and `node scripts/release/check-versions.mjs --version 0.4.0 --binaries`
2. Merge it, then dry-run `main` as above and read the summary.
3. Tag the merge commit and push the tag:

   ```sh
   git switch main && git pull
   git tag -a v0.4.0 -m "Memoar 0.4.0"
   git push origin v0.4.0
   ```

   A dispatch with `publish_release=true` and `version=0.4.0` does the same
   without a local tag.
4. If the `release` environment has required reviewers, approve the deployment
   in the run.
5. Publish the launcher when it changed:

   ```sh
   gh workflow run release.yml --ref main -f version=0.4.0 -f publish_npm=true
   ```

   For a launcher-only fix, set `version` to the new `packages/npx/package.json`
   version. The plan job then checks that the agent release named by
   `AGENT_VERSION` already exists.
6. Check the result from a clean machine:

   ```sh
   curl -fsSL https://github.com/almyty-inc/memoar/releases/latest/download/install.sh | sh
   npx memoar@latest --version
   ```

### When a release is wrong

A GitHub Release can be edited or deleted, but anyone may already have
downloaded it, and the npm launcher of the matching version points at it.
Prefer a new patch release. An npm version cannot be republished. Use
`npm deprecate memoar@<version> "<reason>"` and publish a fixed version.

## Signing

Signing is best effort by default. When a secret is missing the artifact is
still built and published unsigned, the job log carries a warning, and the run
summary and the release notes list which artifacts are unsigned and why.
Credentials that are present but wrong always fail the run.

Set the repository variable `MEMOAR_REQUIRE_SIGNING` to `true` once signing is
set up. Missing credentials then fail the run instead.

### macOS

Needs an Apple Developer Program membership and a **Developer ID Application**
certificate.

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE_P12` | `base64 -i developer-id.p12` of the certificate with its private key |
| `APPLE_CERTIFICATE_PASSWORD` | The password of that .p12 |
| `APPLE_TEAM_ID` | The 10-character team ID |
| `APPLE_SIGNING_IDENTITY` | Optional. The full identity name when the .p12 holds several |
| `APPLE_API_KEY_P8` | Notarization, preferred. `base64 -i AuthKey_XXXX.p8` of an App Store Connect API key with the Developer role |
| `APPLE_API_KEY_ID` | That key's ID |
| `APPLE_API_ISSUER_ID` | The issuer ID shown above the keys list |
| `APPLE_ID`, `APPLE_APP_PASSWORD` | Notarization, alternative. An Apple ID and an app-specific password |

The CLI binaries are signed with the hardened runtime and a secure timestamp,
then notarized. A bare binary cannot hold a stapled ticket, so Gatekeeper
checks it online. The desktop `.app` is re-signed inside out, keeping the
entitlements nsh gave it, put in a disk image, and the image is signed,
notarized and stapled.

### Windows

Two ways, tried in this order.

**Azure Trusted Signing**, recommended. Certificates issued since June 2023
keep their private key in hardware, so a certificate file can no longer be
exported for most new certificates.

| Name | Kind | Value |
| --- | --- | --- |
| `AZURE_TENANT_ID` | secret | Tenant of the app registration |
| `AZURE_CLIENT_ID` | secret | App registration with the Trusted Signing Certificate Profile Signer role |
| `AZURE_CLIENT_SECRET` | secret | Its client secret |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | variable | For example `https://weu.codesigning.azure.net/` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT` | variable | The Trusted Signing account name |
| `AZURE_TRUSTED_SIGNING_PROFILE` | variable | The certificate profile name |

**A certificate file**, when you have an exportable code signing certificate.

| Secret | Value |
| --- | --- |
| `WINDOWS_CERT_PFX` | `base64 -i cert.pfx` |
| `WINDOWS_CERT_PASSWORD` | Its password |

`WINDOWS_TIMESTAMP_URL` (variable) overrides the timestamp server, by default
`http://timestamp.digicert.com`.

### npm

Nothing is stored. npm trusts this repository's `release.yml` through trusted
publishing. On npmjs.com the `memoar` package must list the trusted publisher
`almyty-inc/memoar`, workflow `release.yml`, with no environment.

### Other variables

| Variable | Default | Effect |
| --- | --- | --- |
| `MEMOAR_REQUIRE_SIGNING` | `false` | Fail instead of publishing unsigned macOS or Windows artifacts |

## The desktop packaging contract

The release workflow does not know how the desktop app is built. It calls the
desktop app's own script once on each OS, with `shell: bash` (Git Bash on
Windows), and signs what it leaves behind:

```sh
MEMOAR_DESKTOP_VERSION=<X.Y.Z> agent/scripts/package-desktop.sh <out-dir>
```

Before the call, the workflow has installed the stable Rust toolchain and, on
Linux, `libgtk-4-dev` and `libwebkitgtk-6.0-dev`, and restored the `nsh` CLI from a cache keyed on
`agent/scripts/desktop-nsh.sh`, which pins its version. The script must:

- exit non-zero on any failure
- install the `nsh` it needs when it is missing
- write one archive into `<out-dir>` and print its path as the last line:
  - macOS: `memoar-desktop-<X.Y.Z>-macos-<arch>.zip` holding one ad hoc signed `.app`
  - Linux: `memoar-desktop-<X.Y.Z>-linux-<arch>.tar.gz` holding a `.desktop` file
  - Windows: `memoar-desktop-<X.Y.Z>-windows-<arch>.zip` holding the app's `.exe`
- not sign anything with a real identity, and not upload anything

`<arch>` is `x64` or `arm64`. The workflow then turns the macOS zip into a
signed, notarized and stapled `.dmg` of the same name, signs the Windows
executables and zips them again under the same name, attaches the Linux
archive as it is, and writes a `.sha256` sidecar and a signing status for each.

When the script does not exist on the commit being released, the desktop jobs
skip with a warning in the run summary, and the release goes ahead with the
CLI only. When the script exists and fails, the release does not happen.

Today it packages macOS arm64, Linux x64 and Windows x64.

## Decisions that need a human

- **Signing identities.** Which Apple Developer team signs (an organization
  account shows the company name in Gatekeeper dialogs), and whether Windows
  uses Azure Trusted Signing, which needs identity validation of the publisher,
  or a bought certificate. Until then releases ship unsigned and say so.
- **npm name ownership.** Who owns `memoar` on npmjs.com, who else gets
  publish rights, and that the trusted publisher entry above exists. Consider
  requiring two-factor authentication for the package's maintainers.
- **Domain.** Install commands point at `github.com/almyty-inc/memoar/releases`.
  A short address such as `https://memoar.dev/install.sh` needs a domain and a
  redirect, and both installers already accept any base through
  `MEMOAR_DOWNLOAD_BASE`.
- **Homebrew tap.** `memoar.rb` is attached to every release but not pushed
  anywhere. A tap means creating `almyty-inc/homebrew-tap` and either copying
  the formula by hand per release or giving this workflow a token for it.
- **Release approval.** Whether the `release` environment gets required
  reviewers, so a pushed tag waits for a person before anything is public.
- **Desktop coverage.** Whether a release without desktop packages is
  acceptable, and when to add macOS Intel and Linux arm64 desktop builds.
