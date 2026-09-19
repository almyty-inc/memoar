import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(await readFile(resolve(root, 'contracts/convert-matrix/versions.json'), 'utf8'));
const resumeGate = await readFile(resolve(root, 'agent/scripts/validate-installed-resume.sh'), 'utf8');
const targetVariables = {
  'claude-code': 'claude_version',
  codex: 'codex_version',
  'antigravity-cli': 'antigravity_version',
};
const failures = [];

/*
  The contract version is whatever the generator put on the wire.

  This used to read contracts/VERSION and compare it to versions.json — two
  files that are only ever edited by hand, and which agreed with each other at
  0.2.0 while every generated artefact said 0.3.0 and the OpenAPI document said
  0.1.1. The check was green the whole time, because it never looked at the one
  value any code actually uses. So the source of truth here is the model the
  generator reads, and every hand-maintained marker is checked against it rather
  than against its neighbour.
*/
const model = JSON.parse(await readFile(resolve(root, 'contracts/source/canonical.model.json'), 'utf8'));
const contractVersion = model.contractVersion;
if (typeof contractVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(contractVersion)) {
  console.error('version pin check failed: contracts/source/canonical.model.json has no semantic contractVersion');
  process.exit(1);
}

const markers = {
  'contracts/VERSION': (await readFile(resolve(root, 'contracts/VERSION'), 'utf8')).trim(),
  'contracts/convert-matrix/versions.json': pins.contractVersion,
  'contracts/openapi.yaml': String(
    YAML.parse(await readFile(resolve(root, 'contracts/openapi.yaml'), 'utf8'))?.info?.version,
  ),
  // The generated files are the wire. If one of these has drifted, the
  // generator was not re-run after the model changed.
  'server/libs/canonical/src/generated.ts': (
    await readFile(resolve(root, 'server/libs/canonical/src/generated.ts'), 'utf8')
  ).match(/CONTRACT_VERSION = "([^"]+)"/u)?.[1],
  'agent/crates/memoar-canonical/src/generated.rs': (
    await readFile(resolve(root, 'agent/crates/memoar-canonical/src/generated.rs'), 'utf8')
  ).match(/CONTRACT_VERSION: &str = "([^"]+)"/u)?.[1],
};

for (const [file, value] of Object.entries(markers)) {
  if (value !== contractVersion) {
    failures.push(`${file} says ${value ?? '(unreadable)'} but the contract is ${contractVersion}`);
  }
}

for (const [target, variable] of Object.entries(targetVariables)) {
  const version = pins.targets?.[target];
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    failures.push(`missing semantic version pin for ${target}`);
    continue;
  }
  const matrix = YAML.parse(await readFile(resolve(root, `contracts/convert-matrix/${target}.yaml`), 'utf8'));
  if (matrix.target !== target) failures.push(`conversion matrix target mismatch for ${target}`);
  if (!resumeGate.includes(`${variable}=${version}`)) {
    failures.push(`installed resume gate does not consume ${target} pin ${version}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`version pin check failed: ${failure}`);
  process.exit(1);
}

console.log(
  `version-pins-check ok: contract ${contractVersion} agreed by ${Object.keys(markers).length} markers, ` +
  `${Object.keys(targetVariables).length} installed CLI targets`,
);
