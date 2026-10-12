import { Injectable } from '@nestjs/common';

import {
  Prisma,
  UserRole,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailInUseException, InvalidCredentialsException } from './auth-errors.js';
import type { PublicUser } from './auth.types.js';
import type { LoginDto } from './dto/login.dto.js';
import type { RegisterDto } from './dto/register.dto.js';
import { hashPassword, verifyPassword } from './password.js';
import { TokenService } from './token.service.js';

const UNIQUE_CONSTRAINT_VIOLATION = 'P2002';

function toPublicUser(user: { id: string; email: string; role: UserRole }): PublicUser {
  return { id: user.id, email: user.email, role: user.role };
}

@Injectable()
export class AuthService {
  /**
   * Logging in with an unknown email still runs scrypt, so response time does
   * not tell a caller whether the account exists.
   */
  private readonly placeholderHash: Promise<string> = hashPassword(
    'timing-equalisation-placeholder',
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  async register(dto: RegisterDto): Promise<PublicUser> {
    const email = dto.email.toLowerCase();
    const passwordHash = await hashPassword(dto.password);

    try {
      const user = await this.prisma.user.create({ data: { email, passwordHash } });
      return toPublicUser(user);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === UNIQUE_CONSTRAINT_VIOLATION
      ) {
        throw new EmailInUseException();
      }
      throw error;
    }
  }

  async login(dto: LoginDto): Promise<{ accessToken: string; user: PublicUser }> {
    const email = dto.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });

    const passwordHash = user?.passwordHash ?? (await this.placeholderHash);
    const matches = await verifyPassword(dto.password, passwordHash);

    if (!user || !matches) {
      throw new InvalidCredentialsException();
    }

    const publicUser = toPublicUser(user);
    return { accessToken: await this.tokens.sign(publicUser), user: publicUser };
  }
}
