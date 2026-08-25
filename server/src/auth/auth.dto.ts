import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsEmail, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

/**
 * These mirror the auth request schemas in contracts/openapi.yaml. Every body
 * here was previously declared as an inline interface, which the global
 * ValidationPipe cannot see, so nothing was validated: a missing or wrongly
 * typed field reached the service and surfaced as a 500. /auth/login is
 * unauthenticated, so that was reachable by anyone who could send a request.
 */
export class EmailLoginDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  // The contract's floor. Login must not reveal whether a rejection came from
  // the policy or from the lookup, so this is length only.
  @IsString()
  @MinLength(10)
  @MaxLength(1024)
  password!: string;
}

export class CreateApiKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  scopes!: string[];
}

export class IssueMachineTokenDto {
  @IsUUID()
  machineId!: string;
}
