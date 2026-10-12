import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { INestApplication } from '@nestjs/common';
import {
  PASSWORD,
  createTestApp,
  http,
  login,
  resetDatabase,
  uniqueEmail,
  type TestContext,
} from './utils/test-app.js';

let context: TestContext;
let app: INestApplication;
let prisma: PrismaService;

beforeAll(async () => {
  context = await createTestApp();
  app = context.app;
  prisma = context.prisma;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

describe('POST /auth/register', () => {
  it('creates a customer and never echoes the password', async () => {
    const email = uniqueEmail('customer');

    const response = await http(app)
      .post('/auth/register')
      .send({ email, password: PASSWORD });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ email, role: 'CUSTOMER' });
    expect(response.body.id).toEqual(expect.any(String));
    expect(JSON.stringify(response.body)).not.toContain(PASSWORD);

    const stored = await prisma.user.findUnique({ where: { email } });
    expect(stored?.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(stored?.passwordHash).not.toContain(PASSWORD);
  });

  it('answers a duplicate email with 409 from the real unique constraint', async () => {
    const email = uniqueEmail('customer');
    await http(app).post('/auth/register').send({ email, password: PASSWORD });

    const response = await http(app)
      .post('/auth/register')
      .send({ email, password: 'another-long-password' });

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'EMAIL_IN_USE' });
  });

  it('treats an email that differs only in case as taken', async () => {
    const email = uniqueEmail('customer');
    await http(app).post('/auth/register').send({ email, password: PASSWORD });

    const response = await http(app)
      .post('/auth/register')
      .send({ email: email.toUpperCase(), password: PASSWORD });

    expect(response.status).toBe(409);
  });

  it('refuses to hand out the PROVIDER role through the public endpoint', async () => {
    const response = await http(app)
      .post('/auth/register')
      .send({ email: uniqueEmail('customer'), password: PASSWORD, role: 'PROVIDER' });

    expect(response.status).toBe(400);
  });

  it.each([
    ['a missing email', { password: PASSWORD }],
    ['an address with no @', { email: 'not-an-email', password: PASSWORD }],
    ['a password shorter than the minimum', { email: 'a@b.test', password: 'short123' }],
    ['a missing password', { email: 'a@b.test' }],
  ])('rejects %s with 400', async (_label, body) => {
    const response = await http(app).post('/auth/register').send(body);

    expect(response.status).toBe(400);
  });
});

describe('POST /auth/login', () => {
  it('returns a token that authenticates a booking request', async () => {
    const email = uniqueEmail('customer');
    await http(app).post('/auth/register').send({ email, password: PASSWORD });

    const token = await login(app, email, PASSWORD);
    expect(token.split('.')).toHaveLength(3);
  });

  it('gives an indistinguishable answer for an unknown email and a wrong password', async () => {
    const email = uniqueEmail('customer');
    await http(app).post('/auth/register').send({ email, password: PASSWORD });

    const unknown = await http(app)
      .post('/auth/login')
      .send({ email: uniqueEmail('nobody'), password: PASSWORD });
    const wrong = await http(app)
      .post('/auth/login')
      .send({ email, password: 'definitely-not-the-password' });

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body).toEqual(wrong.body);
  });
});
