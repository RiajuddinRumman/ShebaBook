import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BookingStatus, Prisma } from '../generated/prisma/client.js';
import {
  CustomerDoubleBookingException,
  ListingNotBookableException,
  OutsideBookingWindowException,
  ProviderBusyException,
} from './booking-errors.js';
import { BookingService } from './booking.service.js';
import { CreateBookingDto } from './dto/create-booking.dto.js';
import {
  CUSTOMER_SLOT_CONSTRAINT,
  PROVIDER_SLOT_CONSTRAINT,
} from './slot-constraint.js';

const NOW = '2026-11-01T00:00:00.000Z';
const HOUR = 3_600_000;

interface ListingRow {
  id: string;
  providerId: string;
  durationMinutes: number;
  active: boolean;
}

interface BookingRow {
  id: string;
  customerId: string;
  providerId: string;
  listingId: string;
  startsAt: Date;
  endsAt: Date;
  status: BookingStatus;
}

/**
 * Evaluates the `where` shape BookingService actually builds, using real SQL
 * operator semantics. Unknown keys and operators throw instead of passing
 * silently, so rewriting `lt` to `lte` fails the suite rather than hiding.
 */
function matches(row: BookingRow, where: Record<string, any>): boolean {
  const supported = new Set(['status', 'providerId', 'startsAt', 'endsAt', 'customerId']);
  const unexpected = Object.keys(where).filter((key) => !supported.has(key));
  if (unexpected.length > 0) {
    throw new Error(`fake prisma: unsupported where clause keys ${unexpected.join(', ')}`);
  }

  if (where.status?.in && !where.status.in.includes(row.status)) return false;
  if (where.customerId && row.customerId !== where.customerId) return false;
  if (where.providerId && row.providerId !== where.providerId) return false;

  if (where.startsAt) {
    const ops = Object.keys(where.startsAt);
    if (ops.some((op) => op !== 'lt')) throw new Error('fake prisma: unsupported startsAt operator');
    if (!(row.startsAt < where.startsAt.lt)) return false;
  }

  if (where.endsAt) {
    const ops = Object.keys(where.endsAt);
    if (ops.some((op) => op !== 'gt')) throw new Error('fake prisma: unsupported endsAt operator');
    if (!(row.endsAt > where.endsAt.gt)) return false;
  }

  return true;
}

class FakePrisma {
  listings: ListingRow[] = [];
  rows: BookingRow[] = [];
  private sequence = 0;

  serviceListing = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
      this.listings.find((entry) => entry.id === where.id) ?? null,
    ),
  };

  booking = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, any>; select?: unknown }) =>
      this.rows.find((row) => matches(row, where)) ?? null,
    ),

    create: vi.fn(async ({ data }: { data: Omit<BookingRow, 'id' | 'status'> }) => {
      const row: BookingRow = {
        ...data,
        id: `booking-${++this.sequence}`,
        status: BookingStatus.PENDING,
      };
      this.rows.push(row);
      return row;
    }),
  };

  /** Mirrors Prisma's interactive-transaction callback contract. */
  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const LISTINGS: ListingRow[] = [
  { id: 'listing-a', providerId: 'provider-1', durationMinutes: 60, active: true },
  { id: 'listing-b', providerId: 'provider-1', durationMinutes: 120, active: true },
  { id: 'listing-c', providerId: 'provider-2', durationMinutes: 60, active: true },
  { id: 'listing-dormant', providerId: 'provider-3', durationMinutes: 60, active: false },
];

/** Keeps a seeded row's providerId consistent with its listing, as the service does. */
function providerOf(listingId: string): string {
  const listing = LISTINGS.find((entry) => entry.id === listingId);
  if (!listing) {
    throw new Error(`unknown listing ${listingId}`);
  }
  return listing.providerId;
}

function booking(
  overrides: Partial<BookingRow> & { startsAt: Date; endsAt: Date },
): BookingRow {
  const listingId = overrides.listingId ?? 'listing-b';
  return {
    id: 'seed-1',
    customerId: 'other-customer',
    listingId,
    providerId: providerOf(listingId),
    status: BookingStatus.PENDING,
    ...overrides,
  };
}

function at(iso: string): Date {
  return new Date(iso);
}

/**
 * The shape `@prisma/adapter-pg` produces for SQLSTATE 23P01, verified against
 * a real database rather than guessed from the docs.
 */
function slotExclusionError(constraint: string): unknown {
  const originalMessage = `conflicting key value violates exclusion constraint "${constraint}"`;
  return new Prisma.PrismaClientKnownRequestError('Transaction failed', {
    code: 'P2039',
    clientVersion: 'test',
    meta: {
      modelName: 'Booking',
      driverAdapterError: {
        name: 'DriverAdapterError',
        cause: { kind: 'postgres', code: '23P01', originalCode: '23P01', originalMessage, message: originalMessage },
      },
    },
  });
}

function knownRequestError(code: string, originalMessage: string): unknown {
  return new Prisma.PrismaClientKnownRequestError('Transaction failed', {
    code,
    clientVersion: 'test',
    meta: { driverAdapterError: { name: 'DriverAdapterError', cause: { code: '23514', originalMessage } } },
  });
}

function dto(overrides: Partial<CreateBookingDto> = {}): CreateBookingDto {
  return {
    listingId: 'listing-a',
    startsAt: '2026-11-02T10:00:00.000Z',
    ...overrides,
  } as CreateBookingDto;
}

let prisma: FakePrisma;
let service: BookingService;

function setUp() {
  prisma = new FakePrisma();
  prisma.listings = LISTINGS.map((entry) => ({ ...entry }));
  service = new BookingService(prisma as unknown as ConstructorParameters<typeof BookingService>[0]);
  return prisma;
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(NOW), toFake: ['Date'] });
});

describe('BookingService.create', () => {
  it('derives endsAt from the listing duration and stores it', async () => {
    const rows = setUp();

    const created = await service.create('customer-1', dto({ startsAt: '2026-11-02T10:00:00.000Z' }));

    expect(created.startsAt.toISOString()).toBe('2026-11-02T10:00:00.000Z');
    expect(created.endsAt.toISOString()).toBe('2026-11-02T11:00:00.000Z');
    expect(created.status).toBe(BookingStatus.PENDING);
    expect(created.customerId).toBe('customer-1');
    expect(rows.rows).toHaveLength(1);
  });

  it('uses the duration of the booked listing, not a fixed length', async () => {
    const rows = setUp();

    const created = await service.create(
      'customer-1',
      dto({ listingId: 'listing-b', startsAt: '2026-11-02T10:00:00.000Z' }),
    );

    expect(created.endsAt.toISOString()).toBe('2026-11-02T12:00:00.000Z');
    expect(rows.rows).toHaveLength(1);
  });

  it('rejects an unknown listing with 404 and writes nothing', async () => {
    const rows = setUp();

    const error = await service
      .create('customer-1', dto({ listingId: 'does-not-exist' }))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ListingNotBookableException);
    expect((error as ListingNotBookableException).getStatus()).toBe(404);
    expect(rows.rows).toHaveLength(0);
  });

  it('rejects an inactive listing with the same error as a missing one', async () => {
    const rows = setUp();

    const error = await service
      .create('customer-1', dto({ listingId: 'listing-dormant' }))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ListingNotBookableException);
    expect(rows.rows).toHaveLength(0);
  });

  it.each([
    ['in the past', '2026-10-31T23:00:00.000Z'],
    ['exactly now', NOW],
    ['inside the one hour lead time', '2026-11-01T00:59:59.999Z'],
    ['beyond the 90 day horizon', '2027-02-01T00:00:01.000Z'],
  ])('rejects a start that is %s: %s', async (_label, startsAt) => {
    const rows = setUp();

    const error = await service.create('customer-1', dto({ startsAt })).catch((caught) => caught);

    expect(error).toBeInstanceOf(OutsideBookingWindowException);
    expect((error as OutsideBookingWindowException).getStatus()).toBe(400);
    expect(rows.rows).toHaveLength(0);
  });

  it('accepts the one hour lead time boundary', async () => {
    setUp();

    const created = await service.create(
      'customer-1',
      dto({ startsAt: new Date(Date.parse(NOW) + HOUR).toISOString() }),
    );

    expect(created.startsAt.toISOString()).toBe('2026-11-01T01:00:00.000Z');
    expect(created.endsAt.toISOString()).toBe('2026-11-01T02:00:00.000Z');
  });

  it('rejects overlap with a booking on a different listing of the same provider', async () => {
    const rows = setUp();
    rows.rows.push(
      booking({
        listingId: 'listing-b',
        startsAt: at('2026-11-02T10:30:00.000Z'),
        endsAt: at('2026-11-02T12:30:00.000Z'),
      }),
    );

    const error = await service
      .create('customer-1', dto({ startsAt: '2026-11-02T10:00:00.000Z' }))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ProviderBusyException);
    expect((error as ProviderBusyException).getStatus()).toBe(409);
    expect(rows.rows).toHaveLength(1);
  });

  it('allows back-to-back bookings against the provider calendar', async () => {
    const rows = setUp();
    rows.rows.push(
      booking({
        listingId: 'listing-b',
        startsAt: at('2026-11-02T08:00:00.000Z'),
        endsAt: at('2026-11-02T10:00:00.000Z'),
      }),
    );

    const created = await service.create('customer-1', dto({ startsAt: '2026-11-02T10:00:00.000Z' }));

    expect(created.endsAt.toISOString()).toBe('2026-11-02T11:00:00.000Z');
    expect(rows.rows).toHaveLength(2);
  });

  it('allows a booking abutting the end of a new booking', async () => {
    const rows = setUp();
    rows.rows.push(
      booking({
        listingId: 'listing-b',
        startsAt: at('2026-11-02T11:00:00.000Z'),
        endsAt: at('2026-11-02T13:00:00.000Z'),
      }),
    );

    await service.create('customer-1', dto({ startsAt: '2026-11-02T10:00:00.000Z' }));

    expect(rows.rows).toHaveLength(2);
  });

  it.each([BookingStatus.CANCELLED, BookingStatus.COMPLETED])(
    'ignores a %s booking when checking provider availability',
    async (status) => {
      const rows = setUp();
      rows.rows.push(
        booking({
          listingId: 'listing-b',
          startsAt: at('2026-11-02T10:00:00.000Z'),
          endsAt: at('2026-11-02T12:00:00.000Z'),
          status,
        }),
      );

      await service.create('customer-1', dto({ startsAt: '2026-11-02T10:30:00.000Z' }));

      expect(rows.rows).toHaveLength(2);
    },
  );

  it.each([BookingStatus.PENDING, BookingStatus.CONFIRMED])(
    'treats a %s booking as occupying the calendar',
    async (status) => {
      const rows = setUp();
      rows.rows.push(
        booking({
          listingId: 'listing-b',
          startsAt: at('2026-11-02T10:00:00.000Z'),
          endsAt: at('2026-11-02T12:00:00.000Z'),
          status,
        }),
      );

      const error = await service
        .create('customer-1', dto({ startsAt: '2026-11-02T10:00:00.000Z' }))
        .catch((caught) => caught);

      expect(error).toBeInstanceOf(ProviderBusyException);
    },
  );

  it('stops a customer overlapping themselves across two different providers', async () => {
    const rows = setUp();
    rows.rows.push(
      booking({
        customerId: 'customer-1',
        listingId: 'listing-c',
        startsAt: at('2026-11-02T10:30:00.000Z'),
        endsAt: at('2026-11-02T11:30:00.000Z'),
      }),
    );

    const error = await service
      .create('customer-1', dto({ startsAt: '2026-11-02T10:00:00.000Z' }))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(CustomerDoubleBookingException);
    expect((error as CustomerDoubleBookingException).getStatus()).toBe(409);
    expect(rows.rows).toHaveLength(1);
  });

  it('lets two different customers book two different providers at the same time', async () => {
    const rows = setUp();

    await service.create('customer-1', dto({ startsAt: '2026-11-02T10:00:00.000Z' }));
    await service.create('customer-2', dto({ listingId: 'listing-c', startsAt: '2026-11-02T10:00:00.000Z' }));

    expect(rows.rows).toHaveLength(2);
  });

  it('reports the conflicting window so the client can offer alternatives', async () => {
    const rows = setUp();
    rows.rows.push(
      booking({
        listingId: 'listing-b',
        startsAt: at('2026-11-02T10:00:00.000Z'),
        endsAt: at('2026-11-02T12:00:00.000Z'),
      }),
    );

    const error = await service
      .create('customer-1', dto({ startsAt: '2026-11-02T11:00:00.000Z' }))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ProviderBusyException);
    const response = (error as ProviderBusyException).getResponse() as {
      conflict: { bookingId: string; startsAt: Date; endsAt: Date };
    };
    expect(response.conflict.startsAt.toISOString()).toBe('2026-11-02T10:00:00.000Z');
    expect(response.conflict.endsAt.toISOString()).toBe('2026-11-02T12:00:00.000Z');
  });

  it('never lets a client-supplied status reach the database', async () => {
    const rows = setUp();

    // Simulates a tampered payload that reached the service without the pipe:
    // the service reads only listingId and startsAt.
    const tampered = {
      listingId: 'listing-a',
      startsAt: '2026-11-02T10:00:00.000Z',
      status: 'CONFIRMED',
      endsAt: '2026-11-02T23:00:00.000Z',
    } as unknown as CreateBookingDto;

    await service.create('customer-1', tampered);

    expect(rows.rows[0].status).toBe(BookingStatus.PENDING);
    expect(rows.rows[0].endsAt.toISOString()).toBe('2026-11-02T11:00:00.000Z');
  });

  it('records the booked listing provider on the booking, never the caller', async () => {
    const rows = setUp();

    const created = await service.create('customer-1', dto({ listingId: 'listing-c' }));

    expect(created.providerId).toBe('provider-2');
    expect(rows.rows[0].providerId).toBe('provider-2');
  });

  it('maps a provider slot exclusion to the same 409 the pre-check would give', async () => {
    const rows = setUp();
    const winner = booking({
      customerId: 'customer-2',
      listingId: 'listing-a',
      startsAt: at('2026-11-02T10:00:00.000Z'),
      endsAt: at('2026-11-02T11:00:00.000Z'),
    });
    rows.booking.create.mockImplementation(async () => {
      // The competitor commits between our read and our write.
      rows.rows.push(winner);
      throw slotExclusionError(PROVIDER_SLOT_CONSTRAINT);
    });

    const error = await service
      .create('customer-1', dto({ startsAt: '2026-11-02T10:30:00.000Z' }))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ProviderBusyException);
    expect((error as ProviderBusyException).getResponse()).toMatchObject({
      code: 'PROVIDER_BUSY',
      conflict: { bookingId: winner.id },
    });
    // provider pre-check, customer pre-check, then the re-read that names it
    expect(rows.booking.findFirst).toHaveBeenCalledTimes(3);
  });

  it('maps a customer slot exclusion to the same 409 the pre-check would give', async () => {
    const rows = setUp();
    const winner = booking({
      customerId: 'customer-1',
      listingId: 'listing-c',
      startsAt: at('2026-11-02T10:30:00.000Z'),
      endsAt: at('2026-11-02T11:30:00.000Z'),
    });
    rows.booking.create.mockImplementation(async () => {
      rows.rows.push(winner);
      throw slotExclusionError(CUSTOMER_SLOT_CONSTRAINT);
    });

    const error = await service
      .create('customer-1', dto({ startsAt: '2026-11-02T10:00:00.000Z' }))
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(CustomerDoubleBookingException);
    expect((error as CustomerDoubleBookingException).getResponse()).toMatchObject({
      conflict: { bookingId: winner.id },
    });
  });

  it('rethrows a database error that is not a slot exclusion', async () => {
    const rows = setUp();
    const violation = knownRequestError(
      'P2039',
      'new row violates check constraint "bookings_time_range_is_ordered"',
    );
    rows.booking.create.mockRejectedValue(violation);

    await expect(service.create('customer-1', dto())).rejects.toBe(violation);
  });
});
