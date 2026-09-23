import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

import { NewPasswordRule, PASSWORD_MAX_LENGTH } from "./password-rule.js";

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

export class EmailRegisterDto {
  @IsEmail()
  @MaxLength(320)
  email!: string;

  // The same rule a password change applies: see password-rule.ts.
  @NewPasswordRule()
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;
}

export class ChangePasswordDto {
  // Only bounded, not held to the rule: it is checked against the stored hash,
  // and a password set before the rule existed must still be able to leave.
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword!: string;

  @NewPasswordRule()
  newPassword!: string;
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
