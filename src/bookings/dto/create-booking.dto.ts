import { IsISO8601, IsUUID, Matches } from 'class-validator';

/**
 * `endsAt`, `status` and `customerId` are intentionally absent: endsAt is
 * derived from the listing duration, status starts at PENDING, and the
 * customer comes from the verified JWT.
 */

// @IsISO8601 alone is too loose for bookings: it makes the time and the offset
// optional and accepts ordinal dates ("2026-305"), which parse to an Invalid
// Date whose comparisons are all false -- silently disabling conflict checks.
// This pattern requires a full date, time and zone designator. Calendar
// validity (no 2026-02-30) is still delegated to @IsISO8601.
const ZONED_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export class CreateBookingDto {
  @IsUUID('4')
  listingId: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(ZONED_TIMESTAMP, {
    message: 'startsAt must be a full ISO 8601 timestamp with a UTC offset or Z designator',
  })
  startsAt: string;
}
