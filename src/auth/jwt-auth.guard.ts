import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { CredentialsRequiredException } from './auth-errors.js';
import type { AuthenticatedUser } from './auth.types.js';
import { TokenService } from './token.service.js';

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, token, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return null;
  return token;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = extractBearer(request.headers.authorization);
    if (!token) throw new CredentialsRequiredException();

    const user = await this.tokens.verify(token);
    (request as AuthenticatedRequest).user = user;
    return true;
  }
}
