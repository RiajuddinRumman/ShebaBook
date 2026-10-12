import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password.js';

describe('hashPassword', () => {
  it('verifies a correct password', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('correct horse battery', stored)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const stored = await hashPassword('correct horse battery');
    expect(await verifyPassword('Correct horse battery', stored)).toBe(false);
  });

  it('salts each hash so identical passwords differ', async () => {
    const first = await hashPassword('same-password');
    const second = await hashPassword('same-password');

    expect(first).not.toBe(second);
    expect(await verifyPassword('same-password', first)).toBe(true);
    expect(await verifyPassword('same-password', second)).toBe(true);
  });

  it.each([
    ['empty stored hash', ''],
    ['unknown scheme', 'bcrypt$abc$def'],
    ['missing segments', 'scrypt$onlyone'],
    ['key of the wrong length', 'scrypt$c2FsdA==$a2V5'],
  ])('rejects a malformed stored hash: %s', async (_label, stored) => {
    expect(await verifyPassword('anything', stored)).toBe(false);
  });

  it('never leaks the plaintext into the stored value', async () => {
    const secret = 'unique-plaintext-secret';
    const stored = await hashPassword(secret);

    expect(stored).not.toContain(secret);
    expect(stored.startsWith('scrypt$')).toBe(true);
  });
});
