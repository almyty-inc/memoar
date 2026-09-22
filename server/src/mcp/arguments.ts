import { plainToInstance } from "class-transformer";
import { validateSync, type ValidationError } from "class-validator";

/**
 * Validates MCP tool arguments against a DTO.
 *
 * Tool arguments arrive inside a JSON-RPC body, so the global ValidationPipe —
 * which guards every HTTP body — never sees them: an MCP client can send any
 * shape it likes. This runs the same class-validator rules the HTTP surface
 * runs, with the same settings as `configureApp`: unknown fields are refused
 * rather than quietly forwarded, and nothing is implicitly converted, so a
 * limit of "50" is a malformed argument rather than a number.
 *
 * The refusal says what was wrong, not only where. `invalid_arguments:sessionId`
 * is all a model used to get for passing `"session-42"` to `get_excerpt`, and
 * nothing in the tool's schema said that field has to be a uuid, so the only
 * move left was to send the same call again. class-validator has already
 * written the sentence — "sessionId must be a UUID", and for `pathPattern` a
 * bespoke one about which wildcards are allowed — and it was being discarded
 * one line before it could be used.
 *
 * The `invalid_arguments:<fields>` prefix is unchanged: it is what clients and
 * tests match on, and the explanation follows it.
 */
export function parseToolArguments<T extends object>(type: new () => T, args: Record<string, unknown>): T {
  const instance = plainToInstance(type, args, { enableImplicitConversion: false });
  const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
  if (errors.length > 0) {
    const fields = [...new Set(errors.map((error) => error.property))].sort().join(",");
    throw new Error(`invalid_arguments:${fields} (${errors.map(explain).sort().join("; ")})`);
  }
  return instance;
}

/** One field's failed constraints, as the sentences class-validator wrote for them. */
function explain(error: ValidationError): string {
  const reasons = Object.values(error.constraints ?? {}).filter((reason) => reason.length > 0);
  return reasons.length > 0 ? reasons.join(", ") : `${error.property} is not a valid argument`;
}
