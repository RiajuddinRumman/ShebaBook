import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { BookingStatus, UserRole } from '../src/generated/prisma/client.js';
import type { INestApplication } from '@nestjs/common';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import {
  PASSWORD,
  createCustomer,
  createTestApp,
  http,
  login,
  resetDatabase,
  seedProvider,
  uniqueEmail,
  type ListingSpec,
  type TestContext,
} from './utils/test-app.js';

let app: INestApplication;
let prisma: PrismaService;

const HOUR = 3_600_000;

/** Bookings must land inside the service's one hour to ninety day window. */
function fromNow(hours: number): string {
  return new Date(Date.now() + hours * HOUR).toISOString();
}

function slot(listingId: string, hours: number) {
  return { listingId, startsAt: fromNow(hours) };
}

function endsAt(startsAt: string, minutes: number): string {
  return new Date(Date.parse(startsAt) + minutes * 60_000).toISOString();
}

async function bookAt(token: string, listingId: string, startsAt: string) {
  return http(app)
    .post('/bookings')
    .set('Authorization', `Bearer ${token}`)
    .send({ listingId, startsAt });
}

async function book(token: string, listingId: string, hours: number) {
  return http(app).post('/bookings').set('Authorization', `Bearer ${token}`).send(slot(listingId, hours));
}

async function withProvider(listings: ListingSpec[]) {
  const provider = await seedProvider(prisma, { listings });
  const customer = await createCustomer(app);
  return { provider, customer };
}

const MATHS: ListingSpec = { title: 'Maths', category: 'tutor', durationMinutes: 60 };

/** A bookable listing plus a signed-in customer, built fresh per test. */
async function bookingContext(): Promise<{ listingId: string; token: string }> {
  const { provider, customer } = await withProvider([MATHS]);
  return { listingId: provider.listings[0].id, token: customer.token };
}

beforeAll(async () => {
  const context: TestContext = await createTestApp();
  app = context.app;
  prisma = context.prisma;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase(prisma);
});

describe('POST /bookings', () => {
  it('creates a booking whose end time and provider come from the listing', async () => {
    const { provider, customer } = await withProvider([{ title: 'Maths', category: 'tutor', durationMinutes: 60 }]);

    const response = await book(customer.token, provider.listings[0].id, 24);

    expect(response.status).toBe(201);
    expect(response.body.endsAt).toEqual(endsAt(response.body.startsAt, 60));
    expect(response.body).toMatchObject({
      status: BookingStatus.PENDING,
      customerId: customer.id,
      providerId: provider.providerId,
      listingId: provider.listings[0].id,
    });
  });

  it('derives a 120 minute end for a listing that is 120 minutes long', async () => {
    const { provider, customer } = await withProvider([
      { title: 'Boiler', category: 'repair', durationMinutes: 120 },
    ]);

    const response = await book(customer.token, provider.listings[0].id, 24);

    expect(response.body.endsAt).toEqual(endsAt(response.body.startsAt, 120));
  });

  it('rejects an overlap with the provider calendar with 409', async () => {
    const { provider, customer } = await withProvider([
      { title: 'Maths', category: 'tutor', durationMinutes: 60 },
      { title: 'Physics', category: 'tutor', durationMinutes: 60 },
    ]);
    const other = await createCustomer(app);
    const startsAt = fromNow(24);

    await bookAt(other.token, provider.listings[0].id, startsAt);
    const response = await bookAt(customer.token, provider.listings[1].id, startsAt);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'PROVIDER_BUSY' });
    expect(response.body.conflict).toMatchObject({
      startsAt,
      endsAt: endsAt(startsAt, 60),
    });
    expect(await prisma.booking.count()).toBe(1);
  });

  it('allows a booking that starts exactly when the provider slot ends', async () => {
    const { provider, customer } = await withProvider([
      { title: 'Maths', category: 'tutor', durationMinutes: 60 },
    ]);

    const first = await book(customer.token, provider.listings[0].id, 24);
    const second = await book(customer.token, provider.listings[0].id, 25);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await prisma.booking.count()).toBe(2);
  });

  it('stops one customer double booking across two different providers', async () => {
    const busy = await withProvider([{ title: 'Maths', category: 'tutor', durationMinutes: 60 }]);
    const rival = await seedProvider(prisma, {
      listings: [{ title: 'Repair', category: 'repair', durationMinutes: 60 }],
    });

    await book(busy.customer.token, busy.provider.listings[0].id, 24);
    const response = await book(busy.customer.token, rival.listings[0].id, 24);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ code: 'CUSTOMER_DOUBLE_BOOKED' });
  });

  it('lets two customers hold the same hour with two different providers', async () => {
    const one = await withProvider([{ title: 'Maths', category: 'tutor', durationMinutes: 60 }]);
    const two = await withProvider([{ title: 'Repair', category: 'repair', durationMinutes: 60 }]);

    const first = await book(one.customer.token, one.provider.listings[0].id, 24);
    const second = await book(two.customer.token, two.provider.listings[0].id, 24);

    expect([first.status, second.status]).toEqual([201, 201]);
  });

  it('does not let a cancelled booking occupy the slot', async () => {
    const { provider, customer } = await withProvider([
      { title: 'Maths', category: 'tutor', durationMinutes: 60 },
    ]);
    const other = await createCustomer(app);

    const taken = await book(other.token, provider.listings[0].id, 24);
    await prisma.booking.update({
      where: { id: taken.body.id },
      data: { status: BookingStatus.CANCELLED },
    });

    const response = await book(customer.token, provider.listings[0].id, 24);

    expect(response.status).toBe(201);
  });
});

describe('POST /bookings with invalid input', () => {
  type BodyBuilder = (listingId: string) => Record<string, unknown>;

  it.each([
    ['a listing id that is not a uuid', () => ({ listingId: 'not-a-uuid', startsAt: fromNow(24) })],
    ['a missing listing id', () => ({ startsAt: fromNow(24) })],
    ['a missing start time', (listingId: string) => ({ listingId })],
    ['a date with no time', (listingId: string) => ({ listingId, startsAt: '2026-12-01' })],
    ['a timestamp with no UTC offset', (listingId: string) => ({ listingId, startsAt: '2026-12-01T10:00:00' })],
    ['a start time in the past', (listingId: string) => ({ listingId, startsAt: fromNow(-2) })],
    ['a start time inside the one hour lead', (listingId: string) => ({ listingId, startsAt: fromNow(0.5) })],
    ['a start time beyond the horizon', (listingId: string) => ({ listingId, startsAt: fromNow(24 * 120) })],
    ['a fabricated endsAt', (listingId: string) => ({ listingId, startsAt: fromNow(24), endsAt: fromNow(48) })],
    ['a fabricated customerId', (listingId: string) => ({ listingId, startsAt: fromNow(24), customerId: uniqueEmail('victim') })],
    ['a fabricated status', (listingId: string) => ({ listingId, startsAt: fromNow(24), status: 'CONFIRMED' })],
    ['a timestamp that is not a date', (listingId: string) => ({ listingId, startsAt: 'tomorrow morning' })],
  ] satisfies [string, BodyBuilder][])(
    'rejects %s with 400 and writes nothing',
    async (_label, buildBody) => {
      const { listingId, token } = await bookingContext();

      const response = await http(app)
        .post('/bookings')
        .set('Authorization', `Bearer ${token}`)
        .send(buildBody(listingId));

      expect(response.status).toBe(400);
      expect(await prisma.booking.count()).toBe(0);
    },
  );

  it('answers an unknown listing and an inactive one identically with 404', async () => {
    const { token } = await bookingContext();
    const dormant = await seedProvider(prisma, {
      listings: [{ title: 'Old', category: 'tutor', durationMinutes: 60, active: false }],
    });

    const missing = await http(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send(slot('00000000-0000-4000-8000-000000000001', 24));
    const inactive = await http(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${token}`)
      .send(slot(dormant.listings[0].id, 24));

    expect(missing.status).toBe(404);
    expect(inactive.status).toBe(404);
    expect(inactive.body).toMatchObject(missing.body);
  });
});

describe('POST /bookings access control', () => {
  it('rejects a request with no token', async () => {
    const { provider } = await withProvider([
      { title: 'Maths', category: 'tutor', durationMinutes: 60 },
    ]);

    const response = await http(app).post('/bookings').send(slot(provider.listings[0].id, 24));

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'MISSING_TOKEN' });
  });

  it('rejects a token that is not a JWT', async () => {
    const { provider } = await withProvider([
      { title: 'Maths', category: 'tutor', durationMinutes: 60 },
    ]);

    const response = await http(app)
      .post('/bookings')
      .set('Authorization', 'Bearer not.a.token')
      .send(slot(provider.listings[0].id, 24));

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects a token signed with a different secret', async () => {
    const { provider } = await withProvider([
      { title: 'Maths', category: 'tutor', durationMinutes: 60 },
    ]);
    const forged = await new JwtService({ secret: 'not-the-app-secret' }).signAsync({
      sub: '00000000-0000-4000-8000-000000000001',
      role: UserRole.CUSTOMER,
      email: 'attacker@example.test',
    });

    const response = await http(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${forged}`)
      .send(slot(provider.listings[0].id, 24));

    expect(response.status).toBe(401);
    expect(await prisma.booking.count()).toBe(0);
  });

  it('rejects a token signed with the right secret but no subject', async () => {
    const { provider } = await withProvider([
      { title: 'Maths', category: 'tutor', durationMinutes: 60 },
    ]);
    const blankSubject = await new JwtService({
      secret: process.env.JWT_SECRET ?? 'e2e-only-secret',
    }).signAsync({ sub: '', role: UserRole.CUSTOMER, email: 'someone@example.test' });

    const response = await http(app)
      .post('/bookings')
      .set('Authorization', `Bearer ${blankSubject}`)
      .send(slot(provider.listings[0].id, 24));

    expect(response.status).toBe(401);
  });

  it('refuses a provider a customer-only route with 403', async () => {
    const provider = await seedProvider(prisma, {
      listings: [{ title: 'Maths', category: 'tutor', durationMinutes: 60 }],
    });
    const providerToken = await login(app, provider.email, PASSWORD);

    const response = await book(providerToken, provider.listings[0].id, 24);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    expect(await prisma.booking.count()).toBe(0);
  });
});
