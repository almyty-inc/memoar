import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";

/**
 * Validates MCP tool arguments against a DTO.
 *
 * Tool arguments arrive inside a JSON-RPC body, so the global ValidationPipe —
 * which guards every HTTP body — never sees them: an MCP client can send any
 * shape it likes. This runs the same class-validator rules the HTTP surface
 * runs, with the same settings as `configureApp`: unknown fields are refused
 * rather than quietly forwarded, and nothing is implicitly converted, so a
 * limit of "50" is a malformed argument rather than a number.
 */
export function parseToolArguments<T extends object>(type: new () => T, args: Record<string, unknown>): T {
  const instance = plainToInstance(type, args, { enableImplicitConversion: false });
  const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
  if (errors.length > 0) {
    const fields = [...new Set(errors.map((error) => error.property))].sort().join(",");
    throw new Error(`invalid_arguments:${fields}`);
  }
  return instance;
}
