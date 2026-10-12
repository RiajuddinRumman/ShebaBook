import { computeEndsAt, isValidRange, overlaps, type TimeRange } from './overlap.js';

function range(startsAt: string, endsAt: string): TimeRange {
  return { startsAt: new Date(startsAt), endsAt: new Date(endsAt) };
}

// 10:00-11:00 and 11:00-12:00 on the same day.
const morning = range('2026-11-01T10:00:00Z', '2026-11-01T11:00:00Z');
const midday = range('2026-11-01T11:00:00Z', '2026-11-01T12:00:00Z');

describe('overlaps', () => {
  it('reports overlap for identical ranges', () => {
    expect(overlaps(morning, range('2026-11-01T10:00:00Z', '2026-11-01T11:00:00Z'))).toBe(true);
  });

  it('allows back-to-back bookings: a ends exactly when b starts', () => {
    expect(overlaps(morning, midday)).toBe(false);
  });

  it('allows back-to-back in the opposite argument order', () => {
    expect(overlaps(midday, morning)).toBe(false);
  });

  it('rejects a one-millisecond intrusion', () => {
    expect(overlaps(morning, range('2026-11-01T10:59:59.999Z', '2026-11-01T12:00:00Z'))).toBe(true);
  });

  it('detects containment in either direction', () => {
    const day = range('2026-11-01T08:00:00Z', '2026-11-01T18:00:00Z');
    expect(overlaps(morning, day)).toBe(true);
    expect(overlaps(day, morning)).toBe(true);
  });

  it('separates ranges with a gap', () => {
    expect(overlaps(morning, range('2026-11-01T11:00:01Z', '2026-11-01T12:00:00Z'))).toBe(false);
  });

  it('treats a zero-length range as overlapping nothing', () => {
    const instant = range('2026-11-01T10:30:00Z', '2026-11-01T10:30:00Z');
    expect(overlaps(instant, morning)).toBe(false);
    expect(overlaps(morning, instant)).toBe(false);
  });

  it('treats an inverted range as overlapping nothing', () => {
    const inverted = range('2026-11-01T11:00:00Z', '2026-11-01T10:00:00Z');
    expect(overlaps(inverted, morning)).toBe(false);
    expect(overlaps(morning, inverted)).toBe(false);
  });

  it('is symmetric', () => {
    const pairs = [
      [morning, midday],
      [morning, range('2026-11-01T10:30:00Z', '2026-11-01T10:45:00Z')],
      [morning, range('2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z')],
    ] as const;
    for (const [a, b] of pairs) {
      expect(overlaps(a, b)).toBe(overlaps(b, a));
    }
  });
});

describe('computeEndsAt', () => {
  it('adds the duration in elapsed milliseconds', () => {
    const starts = new Date('2026-11-01T10:00:00Z');
    expect(computeEndsAt(starts, 60).toISOString()).toBe('2026-11-01T11:00:00.000Z');
    expect(computeEndsAt(starts, 90).toISOString()).toBe('2026-11-01T11:30:00.000Z');
    expect(computeEndsAt(starts, 0).toISOString()).toBe('2026-11-01T10:00:00.000Z');
  });

  it('is unaffected by the host timezone', () => {
    const starts = new Date('2026-11-01T10:00:00Z');
    expect(computeEndsAt(starts, 60).getTime() - starts.getTime()).toBe(3_600_000);
  });
});

describe('isValidRange', () => {
  it('rejects inverted and zero-length ranges', () => {
    expect(isValidRange(morning)).toBe(true);
    expect(isValidRange(range('2026-11-01T11:00:00Z', '2026-11-01T10:00:00Z'))).toBe(false);
    expect(isValidRange(range('2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z'))).toBe(false);
  });
});
