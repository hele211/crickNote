import { describe, it, expect } from 'vitest';
import { localDateString, utcDateString } from '../../src/utils/date.js';
import { getISOWeekInfo } from '../../src/agent/context.js';

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

  it('preserves UTC date even when local date differs', () => {
    // 2026-03-24 at 23:30 UTC = 2026-03-25 in UTC+1, but utcDateString must return the UTC date.
    const d = new Date('2026-03-24T23:30:00.000Z');
    expect(utcDateString(d)).toBe('2026-03-24');
  });
});

describe('getISOWeekInfo', () => {
  it('returns week 1 for Jan 1 2026 (a Thursday)', () => {
    const { week, isoYear } = getISOWeekInfo(new Date(2026, 0, 1));
    expect(isoYear).toBe(2026);
    expect(week).toBe(1);
  });

  it('returns ISO year 2026 for Dec 29 2025 (late-December year crossover)', () => {
    // Dec 29 2025 is a Monday — ISO week 1 of 2026, not week 52/53 of 2025.
    const { week, isoYear } = getISOWeekInfo(new Date(2025, 11, 29));
    expect(isoYear).toBe(2026);
    expect(week).toBe(1);
  });

  it('returns ISO year 2025 for Dec 28 2025 (last day of ISO year 2025)', () => {
    // Dec 28 2025 is a Sunday — still ISO week 52 of 2025.
    const { week, isoYear } = getISOWeekInfo(new Date(2025, 11, 28));
    expect(isoYear).toBe(2025);
    expect(week).toBe(52);
  });

  it('returns ISO year 2021 for Jan 1 2021 (Friday in week 53 of 2020)', () => {
    // Jan 1 2021 is a Friday — ISO week 53 of 2020, not week 1 of 2021.
    const { week, isoYear } = getISOWeekInfo(new Date(2021, 0, 1));
    expect(isoYear).toBe(2020);
    expect(week).toBe(53);
  });
});
