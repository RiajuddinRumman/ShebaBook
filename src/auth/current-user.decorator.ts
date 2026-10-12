import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

import type { AuthenticatedUser } from './auth.types.js';

/**
 * Reads only from request.user, which JwtAuthGuard populates from a verified
 * token -- never from the request body.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const { user } = ctx.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (!user) {
      throw new UnauthorizedException('No authenticated user on the request');
    }
    return user;
  },
);
