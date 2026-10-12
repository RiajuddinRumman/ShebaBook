import { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';

import { UserRole } from '../generated/prisma/client.js';
import { CredentialsRequiredException, InvalidTokenException } from './auth-errors.js';
import type { AuthenticatedUser } from './auth.types.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { TokenService } from './token.service.js';

const SECRET = 'guard-test-secret';
const tokens = new TokenService(
  new JwtService({ secret: SECRET, signOptions: { expiresIn: '1h' } }),
);
const guard = new JwtAuthGuard(tokens);

interface FakeRequest {
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  user?: AuthenticatedUser;
}

function contextWith(request: FakeRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const user = { id: 'user-1', role: UserRole.CUSTOMER, email: 'customer@example.test' };

describe('JwtAuthGuard', () => {
  it('accepts a valid bearer token and attaches the user', async () => {
    const request: FakeRequest = { headers: { authorization: `Bearer ${await tokens.sign(user)}` } };

    expect(await guard.canActivate(contextWith(request))).toBe(true);
    expect(request.user).toEqual({
      id: 'user-1',
      role: UserRole.CUSTOMER,
      email: 'customer@example.test',
    });
  });

  it.each([
    ['no authorization header', undefined],
    ['a basic scheme', 'Basic dXNlcjpwYXNz'],
    ['bearer with no token', 'Bearer'],
    ['bearer with trailing junk', 'Bearer abc def'],
    ['an empty bearer token', 'Bearer '],
    ['a lowercase scheme', 'bearer'],
  ])('rejects %s with 401', async (_label, header) => {
    const request: FakeRequest = { headers: header ? { authorization: header } : {} };

    const error = await guard.canActivate(contextWith(request)).catch((caught) => caught);

    expect(error).toBeInstanceOf(CredentialsRequiredException);
    expect((error as CredentialsRequiredException).getStatus()).toBe(401);
    expect(request.user).toBeUndefined();
  });

  it('rejects a forged token with 401', async () => {
    const request: FakeRequest = { headers: { authorization: 'Bearer unsigned.garbage.value' } };

    const error = await guard.canActivate(contextWith(request)).catch((caught) => caught);

    expect(error).toBeInstanceOf(InvalidTokenException);
    expect((error as InvalidTokenException).getStatus()).toBe(401);
  });

  it('never copies identity from the request body', async () => {
    const token = await tokens.sign(user);
    const request: FakeRequest = {
      headers: { authorization: `Bearer ${token}` },
      body: { customerId: 'victim-2' },
    };

    await guard.canActivate(contextWith(request));

    expect(request.user?.id).toBe('user-1');
  });
});
