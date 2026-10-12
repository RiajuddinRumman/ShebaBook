import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';

import { UserRole } from '../../src/generated/prisma/client.js';
import { hashPassword } from '../../src/auth/password.js';
import { AppModule } from '../../src/app.module.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

export const PASSWORD = 'a-long-enough-password';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
}

export async function createTestApp(): Promise<TestContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, prisma: app.get(PrismaService) };
}

/**
 * The exclusion constraints make overlapping rows unwritable, so a test that
 * wants two of them has to clear the table first.
 */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRaw`TRUNCATE "bookings", "service_listings", "provider_profiles", "users" RESTART IDENTITY CASCADE`;
}

export function http(app: INestApplication) {
  return request(app.getHttpServer());
}

export function uniqueEmail(role: string): string {
  return `${role}-${randomUUID()}@example.test`;
}

export interface ListingSpec {
  title: string;
  category: string;
  durationMinutes: number;
  active?: boolean;
  priceCents?: number;
}

export interface ProviderFixture {
  email: string;
  userId: string;
  providerId: string;
  listings: { id: string; durationMinutes: number }[];
}

export async function seedProvider(
  prisma: PrismaService,
  options: { email?: string; city?: string; listings: ListingSpec[] },
): Promise<ProviderFixture> {
  const email = options.email ?? uniqueEmail('provider');
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD), role: UserRole.PROVIDER },
  });
  const profile = await prisma.providerProfile.create({
    data: { userId: user.id, displayName: 'Seeded Provider', city: options.city ?? 'Lisbon' },
  });

  const listings = [];
  for (const spec of options.listings) {
    listings.push(
      await prisma.serviceListing.create({
        data: {
          providerId: profile.id,
          title: spec.title,
          description: 'Seeded listing',
          category: spec.category,
          durationMinutes: spec.durationMinutes,
          priceCents: spec.priceCents ?? 5000,
          active: spec.active ?? true,
        },
      }),
    );
  }

  return { email, userId: user.id, providerId: profile.id, listings };
}

export async function login(app: INestApplication, email: string, password: string): Promise<string> {
  const response = await http(app).post('/auth/login').send({ email, password });
  if (response.status !== 200) {
    throw new Error(`login failed for ${email}: ${response.status} ${response.text}`);
  }
  return response.body.accessToken as string;
}

/** Registers over HTTP like a real customer, then signs in for a token. */
export async function createCustomer(
  app: INestApplication,
  email = uniqueEmail('customer'),
): Promise<{ email: string; token: string; id: string }> {
  const registered = await http(app).post('/auth/register').send({ email, password: PASSWORD });
  if (registered.status !== 201) {
    throw new Error(`register failed for ${email}: ${registered.status} ${registered.text}`);
  }
  return {
    email,
    id: registered.body.id as string,
    token: await login(app, email, PASSWORD),
  };
}
