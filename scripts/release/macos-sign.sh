#!/usr/bin/env bash
# Developer ID signing and notarization for release artifacts.
#
#   macos-sign.sh sign      <status-file> <path>...   Mach-O files or .app bundles
#   macos-sign.sh notarize  <status-file> <path>      a Mach-O file, .app, .dmg or .zip
#
# Signing reads APPLE_CERTIFICATE_P12 (base64 of a "Developer ID Application"
# .p12), APPLE_CERTIFICATE_PASSWORD and APPLE_TEAM_ID. APPLE_SIGNING_IDENTITY
# picks one identity when the .p12 holds several.
#
# Notarization takes an App Store Connect API key (APPLE_API_KEY_P8 as base64
# of the .p8, APPLE_API_KEY_ID, APPLE_API_ISSUER_ID) or an Apple ID
# (APPLE_ID, APPLE_APP_PASSWORD, APPLE_TEAM_ID). The API key wins when both
# are present.
#
# Missing credentials are not an error. The artifact stays unsigned, the status
# file says so, and the job log carries a warning annotation. Set
# MEMOAR_REQUIRE_SIGNING=true to turn that into a failure. Credentials that are
# present but wrong always fail.
#
# The status file collects "signature: ..." and "notarization: ..." lines that
# the release summary renders per artifact.
set -euo pipefail

command=${1:?usage: macos-sign.sh sign|notarize <status-file> <path>...}
status_file=${2:?status file required}
shift 2

warn() { echo "::warning title=macOS signing::$*"; }
record() { printf '%s\n' "$*" >> "$status_file"; }

not_done() {
  local what=$1 reason=$2
  record "${what}: none (${reason})"
  if [ "${MEMOAR_REQUIRE_SIGNING:-false}" = true ]; then
    echo "::error title=macOS signing::${what} skipped: ${reason}, and MEMOAR_REQUIRE_SIGNING is true"
    exit 1
  fi
  warn "${what} skipped for ${3:-the artifact}: ${reason}"
}

keychain=""
cleanup() {
  if [ -n "$keychain" ]; then
    security delete-keychain "$keychain" 2>/dev/null || true
  fi
  rm -f "${RUNNER_TEMP:-/tmp}/memoar-signing.p12" "${RUNNER_TEMP:-/tmp}/memoar-notary.p8"
}
trap cleanup EXIT

import_identity() {
  keychain="${RUNNER_TEMP:-/tmp}/memoar-signing-$$.keychain-db"
  local password p12="${RUNNER_TEMP:-/tmp}/memoar-signing.p12"
  password=$(openssl rand -hex 24)
  printf '%s' "$APPLE_CERTIFICATE_P12" | base64 --decode > "$p12"
  security create-keychain -p "$password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$password" "$keychain"
  security import "$p12" -k "$keychain" -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$password" "$keychain" >/dev/null
  # codesign only searches keychains on the user search list.
  local existing
  existing=$(security list-keychains -d user | tr -d '"' | xargs)
  # shellcheck disable=SC2086
  security list-keychains -d user -s "$keychain" $existing

  identity=${APPLE_SIGNING_IDENTITY:-}
  if [ -z "$identity" ]; then
    identity=$(security find-identity -v -p codesigning "$keychain" \
      | awk -F'"' -v team="(${APPLE_TEAM_ID})" '/Developer ID Application/ && index($2, team) { print $2; exit }')
  fi
  if [ -z "$identity" ]; then
    echo "::error title=macOS signing::the certificate holds no Developer ID Application identity for team ${APPLE_TEAM_ID}"
    security find-identity -v -p codesigning "$keychain"
    exit 1
  fi
}

is_macho() { file -b "$1" | grep -q 'Mach-O'; }

sign_one() {
  local target=$1
  # Re-signing keeps whatever entitlements the packager gave the bundle, such
  # as a JavaScript engine's JIT entitlement. A bare CLI binary has none.
  codesign --force --timestamp --options runtime --preserve-metadata=entitlements \
    --keychain "$keychain" --sign "$identity" "$target"
}

sign() {
  if [ -z "${APPLE_CERTIFICATE_P12:-}" ] || [ -z "${APPLE_CERTIFICATE_PASSWORD:-}" ] || [ -z "${APPLE_TEAM_ID:-}" ]; then
    for path in "$@"; do not_done signature "APPLE_CERTIFICATE_P12, APPLE_CERTIFICATE_PASSWORD or APPLE_TEAM_ID is not set" "$path"; done
    return 0
  fi
  import_identity
  for path in "$@"; do
    if [ -d "$path" ]; then
      # Inside out: nested code first, the bundle itself last. --deep is not
      # used because it signs nested code with the outer bundle's options.
      while IFS= read -r -d '' nested; do
        if [ "$nested" != "$path" ] && is_macho "$nested"; then sign_one "$nested"; fi
      done < <(find "$path/Contents" -type f -print0 | sort -z -r)
      while IFS= read -r -d '' bundle; do
        sign_one "$bundle"
      done < <(find "$path/Contents" -depth -type d \( -name '*.framework' -o -name '*.app' -o -name '*.appex' \) -print0)
    fi
    sign_one "$path"
    codesign --verify --strict --verbose=2 "$path"
    codesign --display --verbose=2 "$path" 2>&1 | grep -E '^(Authority|TeamIdentifier|Timestamp)=' || true
    record "signature: Developer ID (${APPLE_TEAM_ID})"
  done
}

notarize() {
  local path=${1:?path required}
  if ! codesign --verify --strict "$path" 2>/dev/null || ! codesign -dv "$path" 2>&1 | grep -q "TeamIdentifier=${APPLE_TEAM_ID:-none}"; then
    not_done notarization "the artifact carries no Developer ID signature" "$path"
    return 0
  fi
  local auth=()
  if [ -n "${APPLE_API_KEY_P8:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER_ID:-}" ]; then
    local key="${RUNNER_TEMP:-/tmp}/memoar-notary.p8"
    printf '%s' "$APPLE_API_KEY_P8" | base64 --decode > "$key"
    auth=(--key "$key" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID")
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
    auth=(--apple-id "$APPLE_ID" --password "$APPLE_APP_PASSWORD" --team-id "$APPLE_TEAM_ID")
  else
    not_done notarization "neither an App Store Connect API key nor APPLE_ID and APPLE_APP_PASSWORD is set" "$path"
    return 0
  fi

  # notarytool takes a .zip, .dmg or .pkg. A bare binary or an .app goes in a
  # zip made by ditto, which keeps the signature intact.
  local upload=$path
  case "$path" in
    *.dmg|*.zip|*.pkg) ;;
    *) upload="${RUNNER_TEMP:-/tmp}/$(basename "$path").notarize.zip"
       ditto -c -k --keepParent "$path" "$upload" ;;
  esac

  local result id state
  result=$(xcrun notarytool submit "$upload" "${auth[@]}" --wait --timeout 30m --output-format json)
  echo "$result"
  id=$(printf '%s' "$result" | jq -r '.id // empty')
  state=$(printf '%s' "$result" | jq -r '.status // empty')
  if [ "$state" != "Accepted" ]; then
    if [ -n "$id" ]; then xcrun notarytool log "$id" "${auth[@]}" || true; fi
    echo "::error title=macOS notarization::Apple returned '${state:-no status}' for $(basename "$path")"
    exit 1
  fi

  # A bare Mach-O file cannot hold a ticket. Gatekeeper looks it up online.
  case "$path" in
    *.app|*.dmg|*.pkg) xcrun stapler staple "$path" && xcrun stapler validate "$path"
                       record "notarization: accepted and stapled (${id})" ;;
    *)                 record "notarization: accepted (${id}), ticket served online" ;;
  esac
}

case "$command" in
  sign) sign "$@" ;;
  notarize) notarize "$@" ;;
  *) echo "unknown command: $command" >&2; exit 2 ;;
esac
