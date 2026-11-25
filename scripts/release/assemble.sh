#!/usr/bin/env bash
# Turns the per-job build artifacts into the exact file set a release attaches.
#
#   assemble.sh <version> <artifacts-dir> <out-dir>
#
# <artifacts-dir> holds one directory per build job, as actions/download-artifact
# leaves them. Each binary or desktop package arrives with a .sha256 sidecar and
# a .signing status file. The status files are read here and do not ship.
#
# <out-dir> receives the binaries and packages, their sidecars, install.sh,
# install.ps1, the Homebrew formula memoar.rb, SHA256SUMS over every file, and
# release-notes.md. The signing table also goes to $GITHUB_STEP_SUMMARY.
set -euo pipefail

version=${1:?usage: assemble.sh <version> <artifacts-dir> <out-dir>}
artifacts=${2:?artifacts directory required}
out=${3:?output directory required}
root=$(cd "$(dirname "$0")/../.." && pwd)

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

mkdir -p "$out"
status_dir=$(mktemp -d)
trap 'rm -rf "$status_dir"' EXIT

while IFS= read -r -d '' file; do
  name=$(basename "$file")
  case "$name" in
    *.signing) cp "$file" "$status_dir/$name" ;;
    *) cp "$file" "$out/$name" ;;
  esac
done < <(find "$artifacts" -type f -print0)

# Every sidecar must describe the file next to it. A sidecar that drifted from
# its binary would make the launcher refuse a good download, or worse.
for sidecar in "$out"/*.sha256; do
  [ -e "$sidecar" ] || continue
  asset=${sidecar%.sha256}
  expected=$(awk 'NR == 1 { print tolower($1) }' "$sidecar")
  actual=$(sha256 "$asset")
  if [ "$expected" != "$actual" ]; then
    echo "::error::$(basename "$sidecar") says $expected but $(basename "$asset") is $actual"
    exit 1
  fi
done

# Every platform the launcher offers must be here. The list comes from the
# launcher itself, so it cannot drift from what `npx memoar` asks for.
node - "$root/packages/npx/lib/platform.js" "$out" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [platformModule, out] = process.argv.slice(2);
const { TARGETS } = require(platformModule);
const missing = Object.entries(TARGETS)
  .map(([pair, target]) => [pair, `memoar-${target}${target.includes("windows") ? ".exe" : ""}`])
  .filter(([, asset]) => !fs.existsSync(path.join(out, asset)) || !fs.existsSync(path.join(out, `${asset}.sha256`)));
for (const [pair, asset] of missing) {
  console.error(`::error::${pair}: the launcher downloads ${asset}, which this release does not contain`);
}
if (missing.length > 0) process.exit(1);
console.log(`all ${Object.keys(TARGETS).length} launcher platforms have an asset and a checksum`);
NODE

cp "$root/packages/npx/install.sh" "$out/install.sh"
cp "$root/packages/npx/install.ps1" "$out/install.ps1"
bash "$root/scripts/release/homebrew-formula.sh" "$version" "$out" > "$out/memoar.rb"

# SHA256SUMS lists every file a release attaches, in `sha256sum -c` format.
(
  cd "$out"
  rm -f SHA256SUMS
  for file in $(ls | LC_ALL=C sort); do
    case "$file" in
      *.sha256|SHA256SUMS|release-notes.md) continue ;;
    esac
    printf '%s  %s\n' "$(sha256 "$file")" "$file"
  done > SHA256SUMS
)

unsigned=0
table="| Artifact | Signature | Notarization |\n| --- | --- | --- |\n"
for status in "$status_dir"/*.signing; do
  [ -e "$status" ] || continue
  asset=$(basename "$status" .signing)
  signature=$(sed -n 's/^signature: //p' "$status" | tail -1)
  notarization=$(sed -n 's/^notarization: //p' "$status" | tail -1)
  case "$signature" in none*|"") unsigned=$((unsigned + 1)) ;; esac
  table+="| \`${asset}\` | ${signature:-none} | ${notarization:-n/a} |\n"
done

{
  echo "## Memoar ${version}"
  echo
  if [ "$unsigned" -gt 0 ]; then
    echo "> [!WARNING]"
    echo "> ${unsigned} artifact(s) in this release are **not code-signed**. Verify downloads with \`SHA256SUMS\` and \`gh attestation verify\`."
    echo
  fi
  echo "### Install"
  echo
  echo '```sh'
  echo "# macOS and Linux"
  echo "curl -fsSL https://github.com/almyty-inc/memoar/releases/download/v${version}/install.sh | MEMOAR_VERSION=${version} sh"
  echo "# Homebrew, from the formula attached to this release (see docs/install.md)"
  echo "brew tap-new --no-git local/memoar"
  echo "curl -fsSL -o \"\$(brew --repository local/memoar)/Formula/memoar.rb\" https://github.com/almyty-inc/memoar/releases/download/v${version}/memoar.rb"
  echo "brew install local/memoar/memoar"
  echo "# Node.js"
  echo "npx memoar --version"
  echo '```'
  echo
  echo '```powershell'
  echo "# Windows"
  echo "\$env:MEMOAR_VERSION = '${version}'; irm https://github.com/almyty-inc/memoar/releases/download/v${version}/install.ps1 | iex"
  echo '```'
  echo
  if compgen -G "$out/memoar-desktop-*-linux-*.tar.gz" >/dev/null; then
    echo "The Linux desktop archive needs GTK 4 and WebKitGTK 6 at runtime, on Debian and Ubuntu \`libgtk-4-1 libwebkitgtk-6.0-4\`."
    echo
  fi
  echo "### Signing"
  echo
  printf '%b' "$table"
  echo
  echo "Linux binaries are not code-signed on any release. Every file has a SHA-256 in \`SHA256SUMS\` and a build provenance attestation:"
  echo
  echo '```sh'
  echo "sha256sum -c SHA256SUMS --ignore-missing"
  echo "gh attestation verify memoar-x86_64-unknown-linux-gnu --repo almyty-inc/memoar"
  echo '```'
} > "$out/release-notes.md"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$out/release-notes.md" >> "$GITHUB_STEP_SUMMARY"
  { echo; echo "### Files"; echo; echo '```'; cat "$out/SHA256SUMS"; echo '```'; } >> "$GITHUB_STEP_SUMMARY"
fi
if [ "$unsigned" -gt 0 ]; then
  echo "::warning title=Unsigned release artifacts::${unsigned} artifact(s) are not code-signed. See the run summary for which ones and why."
fi
echo "assembled $(wc -l < "$out/SHA256SUMS" | tr -d ' ') files into $out"
