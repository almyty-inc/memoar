#!/usr/bin/env node
// Resolves the version a release run builds and refuses the run when the
// places that carry that version disagree.
//
//   node scripts/release/check-versions.mjs [--version X.Y.Z | --tag vX.Y.Z] [--binaries] [--npm]
//
// --binaries  the agent is being built. agent/Cargo.toml, the memoar-cli entry
//             in agent/Cargo.lock and the launcher's AGENT_VERSION must all
//             equal the version, because the launcher downloads exactly that
//             release tag.
// --npm       the launcher is being published. packages/npx/package.json must
//             equal the version. The launcher versions independently of the
//             agent, so an npm-only run does not check Cargo.
//
// With neither flag only the version format is checked. The resolved version is
// printed on stdout and, under GitHub Actions, written to $GITHUB_OUTPUT.

import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(resolve(root, file), 'utf8');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? '') : '';
};

export function cargoVersion(manifest) {
  const section = manifest.split(/^\[/m).find((part) => part.startsWith('workspace.package]'));
  return section?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
}

export function lockVersion(lock, name) {
  for (const entry of lock.split('[[package]]')) {
    if (new RegExp(`^\\s*name\\s*=\\s*"${name}"\\s*$`, 'm').test(entry)) {
      return entry.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1] ?? null;
    }
  }
  return null;
}

export function agentVersion(platformSource) {
  return platformSource.match(/const AGENT_VERSION = "([^"]+)"/)?.[1] ?? null;
}

const cargo = cargoVersion(read('agent/Cargo.toml'));
const tag = option('--tag').replace(/^refs\/tags\//, '').replace(/^v/, '');
const version = option('--version') || tag || cargo;
const failures = [];

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  failures.push(`"${version}" is not a semantic version`);
}

if (flag('--binaries')) {
  const markers = {
    'agent/Cargo.toml [workspace.package] version': cargo,
    'agent/Cargo.lock memoar-cli': lockVersion(read('agent/Cargo.lock'), 'memoar-cli'),
    'packages/npx/lib/platform.js AGENT_VERSION': agentVersion(read('packages/npx/lib/platform.js')),
  };
  for (const [where, value] of Object.entries(markers)) {
    if (value !== version) failures.push(`${where} is ${value ?? '(unreadable)'} but the release is ${version}`);
  }
}

if (flag('--npm')) {
  const launcher = JSON.parse(read('packages/npx/package.json')).version;
  if (launcher !== version) {
    failures.push(`packages/npx/package.json is ${launcher} but the npm publish is ${version}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`version check failed: ${failure}`);
  process.exit(1);
}

console.log(version);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
}
