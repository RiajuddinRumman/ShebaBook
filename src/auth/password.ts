import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const SCHEME = 'scrypt';

/**
 * Node's built-in scrypt keeps password hashing free of a native dependency.
 * The scheme prefix leaves room to migrate algorithms without a column rename.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = (await derive(password.normalize('NFKC'), salt, KEY_LENGTH)) as Buffer;
  return `${SCHEME}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltPart, keyPart] = stored.split('$');
  if (scheme !== SCHEME || !saltPart || !keyPart) return false;

  const expected = Buffer.from(keyPart, 'base64');
  if (expected.length !== KEY_LENGTH) return false;

  const actual = (await derive(
    password.normalize('NFKC'),
    Buffer.from(saltPart, 'base64'),
    KEY_LENGTH,
  )) as Buffer;

  return timingSafeEqual(actual, expected);
}
