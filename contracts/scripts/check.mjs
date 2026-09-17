import { execFileSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import YAML from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const failures = [];

execFileSync(process.execPath, [resolve(here, "generate.mjs"), "--check"], { stdio: "inherit" });

const schema = JSON.parse(await readFile(resolve(root, "contracts/canonical.schema.json"), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateSession = ajv.compile(schema);
const fixturePaths = (await walk(resolve(root, "contracts/fixtures"))).filter((path) => path.endsWith("expected.canonical.json"));

for (const path of fixturePaths) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (!validateSession(value)) failures.push(`${path}: ${ajv.errorsText(validateSession.errors)}`);
}

const manifest = JSON.parse(await readFile(resolve(root, "contracts/fixtures/manifest.json"), "utf8"));
const tierOne = ["claude-code", "codex", "antigravity-cli", "cursor"];
for (const source of tierOne) {
  const count = manifest.fixtures.filter((fixture) => fixture.source === source).length;
  if (count < 3) failures.push(`fixture coverage: ${source} has ${count}, expected at least 3`);
}
// Every fixture on disk must be declared, and every declaration must exist.
// A fixed floor froze a historical count and had to be lowered whenever an
// unsupportable format was removed, which is the opposite of what it should
// guard: that the manifest and the tree agree.
const declared = new Set(manifest.fixtures.map((fixture) => resolve(root, fixture.expected)));
for (const path of fixturePaths) {
  if (!declared.has(path)) failures.push(`fixture is not in the manifest: ${path}`);
}
for (const fixture of manifest.fixtures) {
  if (!fixturePaths.includes(resolve(root, fixture.expected))) {
    failures.push(`manifest names a fixture that does not exist: ${fixture.expected}`);
  }
}
// A consumer export arrives as the ZIP the vendor hands you.
for (const source of ["chatgpt-export"]) {
  const fixture = manifest.fixtures.find((item) => item.source === source);
  if (!fixture?.input.endsWith(".zip")) failures.push(`consumer export fixture must be a ZIP: ${source}`);
}

const openApi = YAML.parse(await readFile(resolve(root, "contracts/openapi.yaml"), "utf8"));
if (openApi.openapi !== "3.1.0") failures.push("OpenAPI version must be 3.1.0");
const operationIds = [];
for (const [path, pathItem] of Object.entries(openApi.paths ?? {})) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
    if (!operation.operationId) failures.push(`OpenAPI ${method.toUpperCase()} ${path} has no operationId`);
    else operationIds.push(operation.operationId);
  }
}
const duplicateIds = operationIds.filter((id, index) => operationIds.indexOf(id) !== index);
if (duplicateIds.length) failures.push(`duplicate operationIds: ${[...new Set(duplicateIds)].join(", ")}`);

for (const target of ["claude-code", "codex", "antigravity-cli"]) {
  const matrix = YAML.parse(await readFile(resolve(root, `contracts/convert-matrix/${target}.yaml`), "utf8"));
  if (matrix.target !== target || !matrix.resume?.command || !matrix.layout?.length || !matrix.requiredFields?.length) {
    failures.push(`incomplete convert matrix for ${target}`);
  }
}

const secretPatterns = [
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{30,}/,
  /sk-[A-Za-z0-9_-]{24,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:password|secret|token)\s*[:=]\s*["'][^"']{12,}["']/i
];
for (const path of await walk(resolve(root, "contracts/fixtures"))) {
  if (!(await stat(path)).isFile()) continue;
  const content = await readFile(path, "utf8");
  if (secretPatterns.some((pattern) => pattern.test(content))) failures.push(`possible credential in fixture: ${path}`);
}

/*
  Every route the application serves must be in the specification.

  The check validated that each documented operation had an operationId and
  that no two collided — real things, but both about the document's internal
  consistency. Nothing compared the document to the application, so a
  controller could add a route and the spec stayed silent and green. `GET
  /metrics` and `GET /errors` had been served and undocumented for exactly that
  reason.

  The routes are read from the decorators rather than from a running Nest,
  because this runs before anything is built.
*/
const OUTSIDE_V1 = new Set(["/health", "/openapi.json", "/mcp"]);

function specPath(controller, route) {
  const segments = [controller, route]
    .map((part) => (part ?? "").replace(/^\/+|\/+$/gu, ""))
    .filter((part) => part.length > 0)
    .join("/");
  // `:id` in Nest is `{id}` in OpenAPI.
  return `/${segments}`.replace(/:([A-Za-z0-9_]+)/gu, "{$1}");
}

async function servedRoutes(sourceRoot) {
  const found = [];
  for (const file of await walk(sourceRoot)) {
    if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
    const source = await readFile(file, "utf8");
    // A file may hold several controllers; each owns the routes that follow it
    // until the next one.
    const controllers = [...source.matchAll(/@Controller\(\s*(?:"([^"]*)"|'([^']*)')?\s*\)/gu)];
    if (!controllers.length) continue;
    for (const [index, controller] of controllers.entries()) {
      const start = controller.index ?? 0;
      const end = controllers[index + 1]?.index ?? source.length;
      const prefix = controller[1] ?? controller[2] ?? "";
      const body = source.slice(start, end);
      for (const route of body.matchAll(
        /@(Get|Post|Put|Patch|Delete)\(\s*(?:"([^"]*)"|'([^']*)')?\s*\)/gu,
      )) {
        found.push({
          method: route[1].toLowerCase(),
          path: specPath(prefix, route[2] ?? route[3] ?? ""),
          file: relative(root, file),
        });
      }
    }
  }
  return found;
}

const documented = new Set(
  Object.entries(openApi.paths ?? {}).flatMap(([path, item]) =>
    Object.keys(item)
      .filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
      .map((method) => `${method} ${path}`),
  ),
);
for (const route of await servedRoutes(resolve(root, "server/src"))) {
  if (OUTSIDE_V1.has(route.path)) continue;
  if (!documented.has(`${route.method} ${route.path}`)) {
    failures.push(
      `${route.method.toUpperCase()} ${route.path} is served by ${route.file} and is not in openapi.yaml`,
    );
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`contract check failed: ${failure}`);
  process.exit(1);
}

console.log(`contracts-check ok: ${fixturePaths.length} fixtures, ${operationIds.length} API operations, 3 conversion targets`);

async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() ? walk(child) : [child];
  }));
  return nested.flat();
}
