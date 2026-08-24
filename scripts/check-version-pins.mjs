import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(await readFile(resolve(root, 'contracts/convert-matrix/versions.json'), 'utf8'));
const contractVersion = (await readFile(resolve(root, 'contracts/VERSION'), 'utf8')).trim();
const resumeGate = await readFile(resolve(root, 'agent/scripts/validate-installed-resume.sh'), 'utf8');
const targetVariables = {
  'claude-code': 'claude_version',
  codex: 'codex_version',
  'antigravity-cli': 'antigravity_version',
};
const failures = [];

if (pins.contractVersion !== contractVersion) {
  failures.push(`versions.json contractVersion ${pins.contractVersion} does not match contracts/VERSION ${contractVersion}`);
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

console.log(`version-pins-check ok: contract ${contractVersion}, ${Object.keys(targetVariables).length} installed CLI targets`);
