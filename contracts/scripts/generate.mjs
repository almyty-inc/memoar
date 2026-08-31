import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const sourcePath = resolve(root, "contracts/source/canonical.model.json");
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const schema = source.schema;
const checkOnly = process.argv.includes("--check");

const outputs = new Map([
  [resolve(root, "contracts/canonical.schema.json"), `${JSON.stringify(schema, null, 2)}\n`],
  [resolve(root, "server/libs/canonical/src/generated.ts"), generateTypeScript(schema, source.contractVersion)],
  [resolve(root, "agent/crates/memoar-canonical/src/generated.rs"), generateRust(schema, source.contractVersion)],
  [resolve(root, "server/libs/canonical/src/orm.generated.ts"), generateOrm(schema)]
]);

let drift = false;
for (const [path, content] of outputs) {
  if (checkOnly) {
    const current = await readFile(path, "utf8").catch(() => "");
    if (current !== content) {
      console.error(`generated file drift: ${path}`);
      drift = true;
    }
    continue;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  console.log(`generated ${path}`);
}

if (drift) process.exit(1);

function generateTypeScript(inputSchema, contractVersion) {
  const definitions = inputSchema.$defs;
  const lines = [
    "// Generated from contracts/source/canonical.model.json. Do not edit.",
    `export const CONTRACT_VERSION = ${JSON.stringify(contractVersion)} as const;`,
    ""
  ];
  for (const [name, definition] of Object.entries(definitions)) {
    if (name === "Uuid") {
      lines.push("export type Uuid = string;", "");
      continue;
    }
    if (definition.enum) {
      lines.push(`export type ${name} = ${definition.enum.map((value) => JSON.stringify(value)).join(" | ")};`, "");
      continue;
    }
    if (definition.type !== "object") continue;
    const required = new Set(definition.required ?? []);
    lines.push(`export interface ${name} {`);
    for (const [propertyName, property] of Object.entries(definition.properties ?? {})) {
      lines.push(`  ${propertyName}${required.has(propertyName) ? "" : "?"}: ${toTypeScript(property)};`);
    }
    lines.push("}", "");
  }
  return `${lines.join("\n")}\n`;
}

function toTypeScript(node) {
  if (node.$ref) return node.$ref.split("/").at(-1);
  if (node.oneOf) return node.oneOf.map(toTypeScript).join(" | ");
  if (node.enum) return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (node.type === "array") return `Array<${toTypeScript(node.items)}>`;
  if (node.type === "object") return "Record<string, unknown>";
  if (node.type === "integer" || node.type === "number") return "number";
  if (node.type === "boolean") return "boolean";
  if (node.type === "null") return "null";
  return "string";
}

// TypeORM entity schemas for the canonical content tables, derived from the
// canonical model so contract changes propagate into persistence mechanically.
// Harness columns (tenancy, foreign keys, search/audit fields) are declared
// here; every canonical column comes from the model definition.
function ormTables() {
  return [
  {
    definition: "Session",
    table: "sessions",
    skip: ["turns"],
    renames: { createdAt: "capturedCreatedAt", updatedAt: "capturedUpdatedAt" },
    pre: [
      ["id", { type: "uuid", primary: true }, "string"],
      ["tenantId", { type: "uuid" }, "string"]
    ],
    post: [
      ["redactionStatus", { type: "text", default: "clear" }, '"clear" | "findings" | "reviewed"'],
      ["searchDocument", { type: "text", default: "" }, "string"],
      ["searchVector", { type: "tsvector", nullable: true, select: false, insert: false, update: false }, "string | null"],
      ["embedding", { type: "vector", nullable: true, select: false }, "string | null"],
      ["createdAt", { type: "timestamptz", createDate: true }, "Date"],
      ["updatedAt", { type: "timestamptz", updateDate: true }, "Date"]
    ],
    indices: [["tenantId"], ["tenantId", "capturedUpdatedAt"]],
    uniques: []
  },
  {
    definition: "Turn",
    table: "turns",
    skip: ["blocks"],
    renames: { createdAt: "capturedAt" },
    pre: [
      ["id", { type: "uuid", primary: true }, "string"],
      ["tenantId", { type: "uuid" }, "string"],
      ["sessionId", { type: "uuid" }, "string"]
    ],
    post: [],
    indices: [["tenantId"], ["sessionId"]],
    uniques: [["tenantId", "sessionId", "ordinal"]]
  },
  {
    definition: "ContentBlock",
    table: "content_blocks",
    skip: [],
    renames: {},
    pre: [
      ["id", { type: "uuid", primary: true }, "string"],
      ["tenantId", { type: "uuid" }, "string"],
      ["sessionId", { type: "uuid" }, "string"],
      ["turnId", { type: "uuid" }, "string"],
      ["ordinal", { type: "integer" }, "number"]
    ],
    post: [],
    indices: [["tenantId"], ["sessionId"], ["turnId"]],
    uniques: [["tenantId", "turnId", "ordinal"]]
  },
  {
    definition: "MemoryDocument",
    table: "memory_documents",
    skip: [],
    renames: {},
    pre: [
      ["id", { type: "uuid", primary: true }, "string"],
      ["tenantId", { type: "uuid" }, "string"]
    ],
    post: [
      ["createdAt", { type: "timestamptz", createDate: true }, "Date"],
      ["updatedAt", { type: "timestamptz", updateDate: true }, "Date"]
    ],
    indices: [["tenantId"], ["tenantId", "machineId"]],
    // A memory file is identified by where it lives, not by what it says: the
    // same path captured again is the same document with a new revision.
    uniques: [["tenantId", "machineId", "path"]]
  },
  {
    definition: "MemoryRevision",
    table: "memory_revisions",
    skip: [],
    renames: {},
    pre: [
      ["id", { type: "uuid", primary: true }, "string"],
      ["tenantId", { type: "uuid" }, "string"]
    ],
    post: [],
    indices: [["tenantId"], ["documentId"]],
    // Re-reading an unchanged file must not add a revision to its history.
    uniques: [["tenantId", "documentId", "contentHash"]]
  }
  ];
}

function ormColumnFor(node, nullable, definitions) {
  if (node.$ref) {
    const target = node.$ref.split("/").at(-1);
    if (target === "Uuid") return { type: "uuid", ...(nullable ? { nullable: true } : {}) };
    if (definitions[target]?.enum) return { type: "text", ...(nullable ? { nullable: true } : {}) };
    return { type: "jsonb", ...(nullable ? { nullable: true } : {}) };
  }
  if (node.oneOf) {
    const nonNull = node.oneOf.find((item) => item.type !== "null") ?? node.oneOf[0];
    return ormColumnFor(nonNull, true, definitions);
  }
  if (node.enum) return { type: "text", ...(nullable ? { nullable: true } : {}) };
  if (node.type === "array") {
    if (node.items?.type === "string" && !node.items.$ref) return { type: "text", array: true, ...(nullable ? { nullable: true } : {}) };
    return { type: "jsonb", ...(nullable ? { nullable: true } : {}) };
  }
  if (node.type === "object") return { type: "jsonb", ...(nullable ? { nullable: true } : {}) };
  if (node.type === "integer" || node.type === "number") return { type: "integer", ...(nullable ? { nullable: true } : {}) };
  if (node.type === "boolean") return { type: "boolean", ...(nullable ? { nullable: true } : {}) };
  if (node.format === "date-time") return { type: "timestamptz", ...(nullable ? { nullable: true } : {}) };
  return { type: "text", ...(nullable ? { nullable: true } : {}) };
}

function ormTsTypeFor(node, nullable) {
  let base = node.format === "date-time" ? "Date" : toTypeScript(node);
  base = base.replaceAll("Uuid", "string");
  return nullable && !base.split(" | ").includes("null") ? `${base} | null` : base;
}

function ormColumnLiteral(options) {
  const entries = Object.entries(options).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `{ ${entries.join(", ")} }`;
}

function generateOrm(inputSchema) {
  const definitions = inputSchema.$defs;
  const referencedTypes = new Set();
  const lines = [
    "// Generated from contracts/source/canonical.model.json. Do not edit.",
    'import { EntitySchema } from "typeorm";',
    "__IMPORTS__",
    ""
  ];
  for (const table of ormTables()) {
    const definition = definitions[table.definition];
    const required = new Set(definition.required ?? []);
    const rowName = `${table.definition}Row`;
    const columns = [...table.pre];
    for (const [propertyName, property] of Object.entries(definition.properties ?? {})) {
      if (propertyName === "id" || table.skip.includes(propertyName)) continue;
      const columnName = table.renames[propertyName] ?? propertyName;
      const nullable = !required.has(propertyName) || Boolean(property.oneOf?.some((item) => item.type === "null"));
      columns.push([columnName, ormColumnFor(property, nullable, definitions), ormTsTypeFor(property, nullable)]);
      if (property.$ref && property.$ref.split("/").at(-1) !== "Uuid") referencedTypes.add(property.$ref.split("/").at(-1));
      if (property.type === "array" && property.items?.$ref) referencedTypes.add(property.items.$ref.split("/").at(-1));
    }
    columns.push(...table.post);
    lines.push(`export interface ${rowName} {`);
    for (const [name, , tsType] of columns) lines.push(`  ${name}: ${tsType};`);
    lines.push("}", "");
    lines.push(`export const ${table.definition}Entity = new EntitySchema<${rowName}>({`);
    lines.push(`  name: ${JSON.stringify(table.table)},`);
    lines.push(`  tableName: ${JSON.stringify(table.table)},`);
    lines.push("  columns: {");
    for (const [name, options] of columns) lines.push(`    ${name}: ${ormColumnLiteral(options)},`);
    lines.push("  },");
    if (table.indices.length) lines.push(`  indices: [${table.indices.map((columns_) => `{ columns: ${JSON.stringify(columns_)} }`).join(", ")}],`);
    if (table.uniques.length) lines.push(`  uniques: [${table.uniques.map((columns_) => `{ columns: ${JSON.stringify(columns_)} }`).join(", ")}],`);
    lines.push("});", "");
  }
  const imports = referencedTypes.size
    ? `import type { ${[...referencedTypes].sort().join(", ")} } from "./generated.js";`
    : "";
  return `${lines.join("\n").replace("__IMPORTS__", imports)}\n`;
}

function generateRust(inputSchema, contractVersion) {
  const definitions = inputSchema.$defs;
  const lines = [
    "// Generated from contracts/source/canonical.model.json. Do not edit.",
    "use serde::{Deserialize, Serialize};",
    "use std::collections::BTreeMap;",
    "",
    `pub const CONTRACT_VERSION: &str = ${JSON.stringify(contractVersion)};`,
    "",
    "pub type Uuid = String;",
    ""
  ];
  for (const [name, definition] of Object.entries(definitions)) {
    if (name === "Uuid") continue;
    if (definition.enum) {
      lines.push("#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]", "#[serde(rename_all = \"snake_case\")]", `pub enum ${name} {`);
      for (const value of definition.enum) lines.push(`    ${rustVariant(value)},`);
      lines.push("}", "");
      continue;
    }
    if (definition.type !== "object") continue;
    const required = new Set(definition.required ?? []);
    lines.push("#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]", "#[serde(rename_all = \"camelCase\")]", `pub struct ${name} {`);
    for (const [propertyName, property] of Object.entries(definition.properties ?? {})) {
      const rustName = rustField(propertyName);
      const baseType = toRust(property);
      const type = required.has(propertyName) ? baseType : `Option<${baseType}>`;
      lines.push(`    pub ${rustName}: ${type},`);
    }
    lines.push("}", "");
  }
  return `${lines.join("\n")}\n`;
}

function toRust(node) {
  if (node.$ref) return node.$ref.split("/").at(-1);
  if (node.oneOf) {
    const nonNull = node.oneOf.find((item) => item.type !== "null");
    return `Option<${toRust(nonNull)}>`;
  }
  if (node.enum) return "String";
  if (node.type === "array") return `Vec<${toRust(node.items)}>`;
  if (node.type === "object") return "BTreeMap<String, serde_json::Value>";
  if (node.type === "integer") return "u64";
  if (node.type === "number") return "f64";
  if (node.type === "boolean") return "bool";
  return "String";
}

function rustVariant(value) {
  return String(value)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
}

function rustField(value) {
  const snake = value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
  return ["type", "match", "ref", "self", "crate"].includes(snake) ? `${snake}_field` : snake;
}
