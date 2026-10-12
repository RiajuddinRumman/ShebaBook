import { IsEmail, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  // No minimum length here: a short wrong password must fail as "invalid
  // credentials" (401), not as a validation error (400) that leaks the policy.
  @IsString()
  @MaxLength(200)
  password: string;
}
