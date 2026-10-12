import { ConflictException, UnauthorizedException } from '@nestjs/common';

export class EmailInUseException extends ConflictException {
  constructor() {
    super({ code: 'EMAIL_IN_USE', message: 'That email address is already registered' });
  }
}

/** One message for unknown account and wrong password, so neither is separable. */
export class InvalidCredentialsException extends UnauthorizedException {
  constructor() {
    super({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
  }
}

export class CredentialsRequiredException extends UnauthorizedException {
  constructor() {
    super({ code: 'MISSING_TOKEN', message: 'Bearer token is required' });
  }
}

export class InvalidTokenException extends UnauthorizedException {
  constructor() {
    super({ code: 'INVALID_TOKEN', message: 'Invalid or expired token' });
  }
}
