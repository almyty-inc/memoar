import { applyDecorators } from "@nestjs/common";
import { IsString, MaxLength, MinLength } from "class-validator";

/** The shortest password this archive accepts, as the contract and the sign-in form state it. */
export const PASSWORD_MIN_LENGTH = 10;
/** A ceiling so a request cannot make scrypt hash a megabyte. */
export const PASSWORD_MAX_LENGTH = 1024;

/**
 * The rule every password somebody chooses must pass.
 *
 * One definition for registering and for changing a password. Two copies would
 * drift, and the one that drifted lower would be the way around the other.
 * Length only: composition rules push people toward one predictable pattern.
 */
export function NewPasswordRule(): PropertyDecorator {
  return applyDecorators(IsString(), MinLength(PASSWORD_MIN_LENGTH), MaxLength(PASSWORD_MAX_LENGTH));
}
