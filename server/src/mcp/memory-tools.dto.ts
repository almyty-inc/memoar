import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, MinLength } from "class-validator";
import type { MemoryScope } from "../../libs/canonical/src/generated.js";
import { MEMORY_SCOPES } from "../memory/memory.dto.js";

/**
 * A filename glob: letters, digits, separators and the two wildcards.
 *
 * Anything else — brackets, braces, alternation — would be a regular expression
 * in the caller's hands, so it is refused here rather than compiled.
 */
const PATH_PATTERN = /^[\w .*?@+=,'()[\]{}\\/-]+$/u;

/**
 * Arguments for `list_memory_documents`.
 *
 * MCP arguments are not bodies, so the global ValidationPipe never sees them;
 * `parseToolArguments` applies these rules instead. Every bound is here rather
 * than clamped in the handler, so a caller learns its request was wrong instead
 * of receiving an answer to a different one.
 */
export class ListMemoryDocumentsDto {
  @IsOptional()
  @IsUUID()
  machineId?: string;

  @IsOptional()
  @IsIn(MEMORY_SCOPES)
  scope?: MemoryScope;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(4096)
  workspacePath?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @Matches(PATH_PATTERN, { message: "pathPattern accepts path characters and the wildcards * and ?" })
  pathPattern?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset?: number;
}

/** Arguments for `get_memory_document`. */
export class GetMemoryDocumentDto {
  @IsUUID()
  documentId!: string;

  /**
   * How much of the current text to return. These files are written by hand and
   * stay small, but an agent reading one over MCP is spending context on it, so
   * the default is a fraction of the largest one we would store.
   */
  @IsOptional()
  @IsInt()
  @Min(200)
  @Max(200_000)
  maxChars?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  maxRevisions?: number;
}
