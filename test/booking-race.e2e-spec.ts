import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { INestApplication } from '@nestjs/common';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { slotViolationOwner } from '../src/bookings/slot-constraint.js';
import {
  createCustomer,
  createTestApp,
  http,
  resetDatabase,
  seedProvider,
  type TestContext,
} from './utils/test-app.js';

let app: INestApplication;
let prisma: PrismaService;

const HOUR = 3_600_000;

function fromNow(hours: number): string {
  return new Date(Date.now() + hours * HOUR).toISOString();
}

function post(token: string, body: { listingId: string; startsAt: string }) {
  return http(app).post('/bookings').set('Authorization', `Bearer ${token}`).send(body);
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

describe('concurrent booking requests', () => {
  it('writes exactly one booking when five customers race for the same provider slot', async () => {
    const provider = await seedProvider(prisma, {
      listings: [{ title: 'Maths', category: 'tutor', durationMinutes: 60 }],
    });
    const customers = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map(() => createCustomer(app)),
    );
    const startsAt = fromNow(24);

    const responses = await Promise.all(
      customers.map((customer) => post(customer.token, { listingId: provider.listings[0].id, startsAt })),
    );

    const created = responses.filter((response) => response.status === 201);
    const rejected = responses.filter((response) => response.status !== 201);
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    // The losers must be told 409 with the conflict payload, not handed a 500
    // from the exclusion constraint.
    for (const response of rejected) {
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'PROVIDER_BUSY' });
      expect(response.body.conflict.bookingId).toEqual(created[0].body.id);
    }
    expect(await prisma.booking.count()).toBe(1);
  });

  it('stops one customer racing two of its own bookings across different providers', async () => {
    const first = await seedProvider(prisma, {
      listings: [{ title: 'Maths', category: 'tutor', durationMinutes: 60 }],
    });
    const second = await seedProvider(prisma, {
      listings: [{ title: 'Repair', category: 'repair', durationMinutes: 60 }],
    });
    const customer = await createCustomer(app);
    const startsAt = fromNow(24);

    const responses = await Promise.all([
      post(customer.token, { listingId: first.listings[0].id, startsAt }),
      post(customer.token, { listingId: second.listings[0].id, startsAt }),
    ]);

    const accepted = responses.filter((response) => response.status === 201);
    const rejected = responses.filter((response) => response.status !== 201);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status).toBe(409);
    expect(rejected[0].body).toMatchObject({ code: 'CUSTOMER_DOUBLE_BOOKED' });
    expect(await prisma.booking.count()).toBe(1);
  });

  it('keeps back-to-back slots writable under the same race', async () => {
    const provider = await seedProvider(prisma, {
      listings: [{ title: 'Maths', category: 'tutor', durationMinutes: 60 }],
    });
    const customers = await Promise.all(
      Array.from({ length: 4 }, () => createCustomer(app)),
    );
    const startsAt = Date.parse(fromNow(24));

    const responses = await Promise.all(
      customers.map((customer, index) =>
        post(customer.token, {
          listingId: provider.listings[0].id,
          startsAt: new Date(startsAt + index * HOUR).toISOString(),
        }),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201]);
    expect(await prisma.booking.count()).toBe(4);
  });

  it('blocks an overlapping write that bypasses the service entirely', async () => {
    const provider = await seedProvider(prisma, {
      listings: [
        { title: 'Maths', category: 'tutor', durationMinutes: 60 },
        { title: 'Physics', category: 'tutor', durationMinutes: 60 },
      ],
    });
    const one = await createCustomer(app);
    const two = await createCustomer(app);
    const startsAt = new Date(fromNow(24));
    const endsAt = new Date(startsAt.getTime() + HOUR);

    await prisma.booking.create({
      data: {
        customerId: one.id,
        providerId: provider.providerId,
        listingId: provider.listings[0].id,
        startsAt,
        endsAt,
      },
    });

    const rejected = await prisma.booking
      .create({
        data: {
          customerId: two.id,
          providerId: provider.providerId,
          listingId: provider.listings[1].id,
          startsAt,
          endsAt,
        },
      })
      .catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(Error);
    expect(slotViolationOwner(rejected)).toBe('provider');
    expect(await prisma.booking.count()).toBe(1);
  });

  it('blocks the same customer double booking across providers at the database too', async () => {
    const maths = await seedProvider(prisma, {
      listings: [{ title: 'Maths', category: 'tutor', durationMinutes: 60 }],
    });
    const repair = await seedProvider(prisma, {
      listings: [{ title: 'Repair', category: 'repair', durationMinutes: 60 }],
    });
    const customer = await createCustomer(app);
    const startsAt = new Date(fromNow(24));

    await prisma.booking.create({
      data: {
        customerId: customer.id,
        providerId: maths.providerId,
        listingId: maths.listings[0].id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + HOUR),
      },
    });

    const rejected = await prisma.booking
      .create({
        data: {
          customerId: customer.id,
          providerId: repair.providerId,
          listingId: repair.listings[0].id,
          startsAt,
          endsAt: new Date(startsAt.getTime() + HOUR),
        },
      })
      .catch((error: unknown) => error);

    expect(slotViolationOwner(rejected)).toBe('customer');
    expect(await prisma.booking.count()).toBe(1);
  });
});
