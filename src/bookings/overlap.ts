export interface TimeRange {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * Half-open interval overlap: [startsAt, endsAt).
 *
 * Strict `<` makes back-to-back bookings compatible. Degenerate or inverted
 * ranges are the empty set, so they overlap nothing; without this guard the
 * comparison alone reports a zero-length range as overlapping its container.
 */
export function overlaps(a: TimeRange, b: TimeRange): boolean {
  if (!isValidRange(a) || !isValidRange(b)) return false;
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

export function computeEndsAt(startsAt: Date, durationMinutes: number): Date {
  return new Date(startsAt.getTime() + durationMinutes * 60_000);
}

export function isValidRange(range: TimeRange): boolean {
  return range.endsAt > range.startsAt;
}
