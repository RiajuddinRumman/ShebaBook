import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserRole } from '../generated/prisma/client.js';
import { InvalidCredentialsException } from './auth-errors.js';
import { AuthService } from './auth.service.js';
import { verifyPassword } from './password.js';
import { TokenService } from './token.service.js';

vi.mock('./password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./password.js')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

const mockedVerify = vi.mocked(verifyPassword);

interface StoredUser {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
}

class FakeUsers {
  rows: StoredUser[] = [];
  private sequence = 0;

  user = {
    create: vi.fn(async ({ data }: { data: { email: string; passwordHash: string } }) => {
      const row: StoredUser = {
        id: `user-${++this.sequence}`,
        role: UserRole.CUSTOMER,
        email: data.email,
        passwordHash: data.passwordHash,
      };
      this.rows.push(row);
      return row;
    }),

    findUnique: vi.fn(async ({ where }: { where: { email: string } }) =>
      this.rows.find((row) => row.email === where.email) ?? null,
    ),
  };
}

const tokens = new TokenService(
  new JwtService({ secret: 'auth-service-test-secret', signOptions: { expiresIn: '1h' } }),
);

let users: FakeUsers;
let service: AuthService;

beforeEach(() => {
  mockedVerify.mockClear();
  users = new FakeUsers();
  service = new AuthService(
    users as unknown as ConstructorParameters<typeof AuthService>[0],
    tokens,
  );
});

describe('AuthService.register', () => {
  it('stores a derived hash and never the plaintext password', async () => {
    const password = 'a-long-enough-password';

    await service.register({ email: 'customer@example.test', password });

    const stored = users.rows[0];
    expect(stored.passwordHash).not.toContain(password);
    expect(stored.passwordHash.startsWith('scrypt$')).toBe(true);
  });

  it('normalises the email to lower case', async () => {
    await service.register({ email: 'Mixed.Case@Example.TEST', password: 'a-long-enough-password' });

    expect(users.rows[0].email).toBe('mixed.case@example.test');
  });

  it('creates the account as a CUSTOMER', async () => {
    const created = await service.register({
      email: 'customer@example.test',
      password: 'a-long-enough-password',
    });

    expect(created.role).toBe(UserRole.CUSTOMER);
  });

  it('returns only public fields', async () => {
    const created = await service.register({
      email: 'customer@example.test',
      password: 'a-long-enough-password',
    });

    expect(Object.keys(created).sort()).toEqual(['email', 'id', 'role']);
  });
});

describe('AuthService.login', () => {
  async function registerAndReturnPassword(email = 'customer@example.test') {
    const password = 'a-long-enough-password';
    await service.register({ email, password });
    return password;
  }

  it('issues a token that resolves back to the authenticated identity', async () => {
    const password = await registerAndReturnPassword();

    const result = await service.login({ email: 'customer@example.test', password });

    expect(Object.keys(result.user).sort()).toEqual(['email', 'id', 'role']);
    expect(await tokens.verify(result.accessToken)).toEqual({
      id: result.user.id,
      role: UserRole.CUSTOMER,
      email: 'customer@example.test',
    });
  });

  it('accepts an email cased differently at registration', async () => {
    const password = await registerAndReturnPassword('Mixed.Case@Example.TEST');

    const result = await service.login({ email: 'mixed.case@example.test', password });

    expect(result.user.email).toBe('mixed.case@example.test');
  });

  it('rejects a wrong password', async () => {
    const password = await registerAndReturnPassword();

    await expect(
      service.login({ email: 'customer@example.test', password: `${password}-but-wrong` }),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);

    expect(mockedVerify).toHaveBeenCalledWith(
      `${password}-but-wrong`,
      users.rows[0].passwordHash,
    );
  });

  it('rejects an unknown email', async () => {
    await expect(
      service.login({ email: 'nobody@example.test', password: 'whatever-the-password-is' }),
    ).rejects.toBeInstanceOf(InvalidCredentialsException);
  });

  it('gives an indistinguishable answer for unknown email and wrong password', async () => {
    const password = await registerAndReturnPassword();

    const unknown = await service
      .login({ email: 'nobody@example.test', password })
      .catch((error) => error);
    const wrong = await service
      .login({ email: 'customer@example.test', password: 'definitely-not-it' })
      .catch((error) => error);

    expect(unknown).toBeInstanceOf(InvalidCredentialsException);
    expect(wrong).toBeInstanceOf(InvalidCredentialsException);
    expect((unknown as InvalidCredentialsException).getResponse()).toEqual(
      (wrong as InvalidCredentialsException).getResponse(),
    );
  });

  it('spends the same key-derivation work on an unknown email as on a known one', async () => {
    const password = await registerAndReturnPassword();
    mockedVerify.mockClear();

    await service.login({ email: 'nobody@example.test', password }).catch(() => undefined);
    const unknownWork = mockedVerify.mock.calls.map(([, hash]) => hash);

    mockedVerify.mockClear();
    await service
      .login({ email: 'customer@example.test', password: `${password}-but-wrong` })
      .catch(() => undefined);
    const knownWork = mockedVerify.mock.calls.map(([, hash]) => hash);

    expect(unknownWork).toHaveLength(1);
    expect(knownWork).toHaveLength(1);
    // The unknown-email branch must still verify against a real scrypt hash,
    // not skip straight to the exception.
    expect(unknownWork[0].startsWith('scrypt$')).toBe(true);
    expect(unknownWork[0]).not.toBe(knownWork[0]);
  });

  it('never returns the stored hash', async () => {
    const password = await registerAndReturnPassword();

    const result = await service.login({ email: 'customer@example.test', password });

    expect(JSON.stringify(result)).not.toContain(users.rows[0].passwordHash);
  });
});
