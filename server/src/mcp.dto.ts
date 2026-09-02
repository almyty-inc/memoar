import { IsString, MaxLength, MinLength } from "class-validator";

/**
 * The handshake body.
 *
 * A class, not an inline interface: the validation pipe cannot see an
 * interface, so a body of any shape reached the handler and came back as a 500
 * — the same defect that made every malformed login a server error.
 */
export class McpHandshakeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  clientName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  protocolVersion!: string;
}
