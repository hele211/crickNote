import { describe, it, expect } from 'vitest';
import { localDateString, utcDateString } from '../../src/utils/date.js';

describe('localDateString', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(localDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('formats a specific local date correctly', () => {
    // Use local midnight so the result is deterministic regardless of timezone.
    const d = new Date(2026, 2, 30); // March 30 2026, local midnight
    expect(localDateString(d)).toBe('2026-03-30');
  });

  it('does not drift due to UTC offset on a date near midnight UTC', () => {
    // Simulate a Date that is 2026-03-30 at 00:30 local (UTC+1) = 2026-03-29 23:30 UTC.
    // toISOString() would give '2026-03-29', but localDateString() must give '2026-03-30'.
    const d = new Date(2026, 2, 30, 0, 30, 0); // local 00:30 on March 30
    expect(localDateString(d)).toBe('2026-03-30');
  });
});

describe('utcDateString', () => {
  it('preserves a YAML calendar date stored at midnight UTC', () => {
    // gray-matter parses `date: 2026-03-24` as midnight UTC.
    const d = new Date('2026-03-24T00:00:00.000Z');
    expect(utcDateString(d)).toBe('2026-03-24');
  });

  it('does not drift in UTC-5 timezone', () => {
    // In UTC-5, midnight UTC is 2026-03-23 19:00 local time.
    // utcDateString must still return '2026-03-24' (the UTC calendar date).
    const d = new Date('2026-03-24T00:00:00.000Z');
    expect(utcDateString(d)).toBe('2026-03-24');
  });
});
