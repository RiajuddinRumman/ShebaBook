import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';

import { CreateBookingDto } from './create-booking.dto.js';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
});

const metadata: ArgumentMetadata = {
  type: 'body',
  metatype: CreateBookingDto,
};

const LISTING_ID = '2c7e4d5a-9b3f-4a1c-8e2d-1f6a5b4c3d2e';

function payload(extra: Record<string, unknown> = {}) {
  return { listingId: LISTING_ID, startsAt: '2026-11-01T10:00:00.000Z', ...extra };
}

async function failures(body: unknown): Promise<string> {
  try {
    await pipe.transform(body, metadata);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse() as {
      message: string | string[];
    };
    return [response.message].flat().join('; ');
  }
  throw new Error(`expected validation to reject ${JSON.stringify(body)}`);
}

describe('CreateBookingDto', () => {
  it('accepts a valid body and produces a CreateBookingDto instance', async () => {
    const result = await pipe.transform(payload(), metadata);

    expect(result).toBeInstanceOf(CreateBookingDto);
    expect(result).toEqual({
      listingId: LISTING_ID,
      startsAt: '2026-11-01T10:00:00.000Z',
    });
  });

  it('accepts an explicit UTC offset', async () => {
    const result = await pipe.transform(
      payload({ startsAt: '2026-11-01T10:00:00+06:00' }),
      metadata,
    );
    expect(result.startsAt).toBe('2026-11-01T10:00:00+06:00');
  });

  it('rejects an empty body', async () => {
    const message = await failures({});
    expect(message).toContain('listingId');
    expect(message).toContain('startsAt');
  });

  it('rejects a missing startsAt', async () => {
    const message = await failures({ listingId: LISTING_ID });
    expect(message).toContain('startsAt');
  });

  it('rejects a missing listingId', async () => {
    const message = await failures({ startsAt: '2026-11-01T10:00:00.000Z' });
    expect(message).toContain('listingId');
  });

  it('rejects a listingId that is not a UUID', async () => {
    expect(await failures(payload({ listingId: 'not-a-uuid' }))).toContain('listingId');
  });

  it('rejects a UUID that is not version 4', async () => {
    const v1 = '2c7e4d5a-9b3f-1a1c-8e2d-1f6a5b4c3d2e';
    expect(await failures(payload({ listingId: v1 }))).toContain('listingId');
  });

  it('rejects a non-ISO startsAt', async () => {
    for (const startsAt of ['01/11/2026', 'tomorrow', '2026-13-40T99:99:99Z']) {
      expect(await failures(payload({ startsAt }))).toContain('startsAt');
    }
  });

  // Each of these is accepted by a bare @IsISO8601 but is unusable as a
  // booking instant: they are Invalid Dates in JS, so every comparison
  // against them is false and a conflict check would silently pass.
  it.each([
    ['date only', '2026-11-01'],
    ['ordinal date', '2026-305'],
    ['week date', '2026-W01-3'],
    ['space separator', '2026-11-01 10:00:00Z'],
    ['no zone designator', '2026-11-01T10:00:00'],
    ['hour 24', '2026-11-01T24:00:00Z'],
    ['invalid calendar day', '2026-02-30T10:00:00Z'],
    ['offset without colon', '2026-11-01T10:00:00+0600'],
  ])('rejects a %s: %s', async (_label, startsAt) => {
    expect(await failures(payload({ startsAt }))).toContain('startsAt');
  });

  it('never lets a rejected string survive as an Invalid Date', async () => {
    const rejected = ['2026-11-01', '2026-305', '2026-W01-3', '2026-11-01T10:00:00'];
    for (const startsAt of rejected) {
      await expect(pipe.transform(payload({ startsAt }), metadata)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });

  it('accepts only timestamps that parse to a real instant', async () => {
    const cases = [
      ['2026-11-01T10:00:00.000Z', '2026-11-01T10:00:00.000Z'],
      ['2026-11-01T10:00:00Z', '2026-11-01T10:00:00.000Z'],
      ['2026-11-01T10:00Z', '2026-11-01T10:00:00.000Z'],
      // Offsets must shift the instant, not be ignored.
      ['2026-11-01T10:00:00+06:00', '2026-11-01T04:00:00.000Z'],
      ['2026-11-01T10:00:00-05:30', '2026-11-01T15:30:00.000Z'],
    ] as const;

    for (const [startsAt, expectedUtc] of cases) {
      const result = await pipe.transform(payload({ startsAt }), metadata);
      expect(new Date(result.startsAt).toISOString()).toBe(expectedUtc);
    }
  });

  it('rejects a startsAt that is not a string', async () => {
    expect(await failures(payload({ startsAt: 1_762_000_000_000 }))).toContain('startsAt');
  });

  it('rejects a startsAt that is null', async () => {
    expect(await failures(payload({ startsAt: null }))).toContain('startsAt');
  });

  it.each(['endsAt', 'status', 'customerId', 'priceCents', 'durationMinutes'])(
    'rejects a client-supplied %p instead of silently stripping it',
    async (field) => {
      const message = await failures(payload({ [field]: 'injected' }));
      expect(message).toContain(field);
    },
  );
});
