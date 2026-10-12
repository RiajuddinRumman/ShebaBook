import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { UserRole } from '../generated/prisma/client.js';
import { InvalidTokenException } from './auth-errors.js';
import type {
  AccessTokenPayload,
  AuthenticatedUser,
  PublicUser,
} from './auth.types.js';

const ISSUED_ROLES: UserRole[] = [UserRole.CUSTOMER, UserRole.PROVIDER];

/**
 * A blank `sub` would otherwise authenticate as a user with an empty id and
 * reach the booking write path, so a string claim must also have content.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

@Injectable()
export class TokenService {
  constructor(private readonly jwt: JwtService) {}

  async sign(user: PublicUser): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      role: user.role,
      email: user.email,
    };
    return this.jwt.signAsync(payload);
  }

  async verify(token: string): Promise<AuthenticatedUser> {
    let payload: AccessTokenPayload | undefined;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch {
      throw new InvalidTokenException();
    }

    if (
      !payload ||
      !isNonEmptyString(payload.sub) ||
      !isNonEmptyString(payload.email) ||
      !ISSUED_ROLES.includes(payload.role)
    ) {
      throw new InvalidTokenException();
    }

    return { id: payload.sub, role: payload.role, email: payload.email };
  }
}
