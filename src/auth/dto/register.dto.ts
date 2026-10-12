import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `role` is deliberately not accepted: registering must never let a caller
 * self-assign PROVIDER. Provider onboarding is a separate, reviewed flow.
 */
export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(10)
  @MaxLength(200)
  password: string;
}
