import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';

import { UserRole } from '../generated/prisma/client.js';
import { InvalidTokenException } from './auth-errors.js';
import { TokenService } from './token.service.js';

const SECRET = 'token-service-test-secret';
const OTHER_SECRET = 'a-completely-different-secret';

function decodePayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

const tokens = new TokenService(new JwtService({ secret: SECRET, signOptions: { expiresIn: '1h' } }));

const customer = {
  id: 'user-1',
  role: UserRole.CUSTOMER,
  email: 'customer@example.test',
};

describe('TokenService', () => {
  it('round-trips a signed user through verification', async () => {
    const token = await tokens.sign(customer);

    expect(await tokens.verify(token)).toEqual({
      id: 'user-1',
      role: UserRole.CUSTOMER,
      email: 'customer@example.test',
    });
  });

  it('carries the identity in `sub` and never in an `id` claim', async () => {
    const claims = decodePayload(await tokens.sign(customer));

    expect(claims.sub).toBe('user-1');
    expect(claims).not.toHaveProperty('id');
  });

  it('reads identity from `sub`, not from an injected `id` claim', async () => {
    const forged = await new JwtService({ secret: SECRET }).signAsync({
      sub: customer.id,
      id: 'someone-else',
      role: customer.role,
      email: customer.email,
    });

    expect(await tokens.verify(forged)).toEqual({
      id: 'user-1',
      role: UserRole.CUSTOMER,
      email: customer.email,
    });
  });

  it('rejects a token signed with a different secret', async () => {
    const foreign = await new JwtService({ secret: OTHER_SECRET }).signAsync(customer);

    await expect(tokens.verify(foreign)).rejects.toBeInstanceOf(InvalidTokenException);
  });

  it('rejects an expired token', async () => {
    const expired = await new JwtService({ secret: SECRET }).signAsync(
      { sub: customer.id, role: customer.role, email: customer.email },
      { expiresIn: -10 },
    );

    await expect(tokens.verify(expired)).rejects.toBeInstanceOf(InvalidTokenException);
  });

  it('rejects a token that is not a JWT at all', async () => {
    await expect(tokens.verify('not-a-jwt')).rejects.toBeInstanceOf(InvalidTokenException);
  });

  it.each([
    ['no subject', { role: UserRole.CUSTOMER, email: 'a@b.test' }],
    ['unknown role', { sub: 'user-1', role: 'ADMIN', email: 'a@b.test' }],
    ['no email', { sub: 'user-1', role: UserRole.CUSTOMER }],
    ['empty subject', { sub: '', role: UserRole.CUSTOMER, email: 'a@b.test' }],
    ['whitespace subject', { sub: '   ', role: UserRole.CUSTOMER, email: 'a@b.test' }],
    ['numeric subject', { sub: 42, role: UserRole.CUSTOMER, email: 'a@b.test' }],
    ['blank email', { sub: 'user-1', role: UserRole.CUSTOMER, email: '   ' }],
  ])('rejects a well-signed payload with %s', async (_label, payload) => {
    const forged = await new JwtService({ secret: SECRET }).signAsync(payload);
    await expect(tokens.verify(forged)).rejects.toBeInstanceOf(InvalidTokenException);
  });

  it('accepts a provider role', async () => {
    const provider = { ...customer, id: 'user-2', role: UserRole.PROVIDER };
    const token = await tokens.sign(provider);

    expect((await tokens.verify(token)).role).toBe(UserRole.PROVIDER);
  });
});
