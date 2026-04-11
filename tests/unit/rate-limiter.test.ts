import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/server/rate-limiter.js';

describe('RateLimiter', () => {
  it('allows messages under the limit', () => {
    const limiter = new RateLimiter({ maxMessages: 5, windowMs: 1000 });

    for (let i = 0; i < 5; i++) {
      expect(limiter.allow('client-1')).toBe(true);
    }
  });

  it('rejects messages over the limit', () => {
    const limiter = new RateLimiter({ maxMessages: 3, windowMs: 1000 });

    expect(limiter.allow('client-1')).toBe(true);
    expect(limiter.allow('client-1')).toBe(true);
    expect(limiter.allow('client-1')).toBe(true);
    expect(limiter.allow('client-1')).toBe(false); // 4th message rejected
    expect(limiter.allow('client-1')).toBe(false); // still rejected
  });

  it('tracks clients independently', () => {
    const limiter = new RateLimiter({ maxMessages: 2, windowMs: 1000 });

    expect(limiter.allow('client-1')).toBe(true);
    expect(limiter.allow('client-1')).toBe(true);
    expect(limiter.allow('client-1')).toBe(false); // client-1 exhausted

    // client-2 should still be allowed
    expect(limiter.allow('client-2')).toBe(true);
    expect(limiter.allow('client-2')).toBe(true);
  });

  it('allows messages again after the window expires', () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter({ maxMessages: 2, windowMs: 1000 });

      expect(limiter.allow('c')).toBe(true);
      expect(limiter.allow('c')).toBe(true);
      expect(limiter.allow('c')).toBe(false);

      // Advance time past the window
      vi.advanceTimersByTime(1001);

      // Should be allowed again
      expect(limiter.allow('c')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('remove cleans up client tracking', () => {
    const limiter = new RateLimiter({ maxMessages: 2, windowMs: 1000 });

    expect(limiter.allow('c')).toBe(true);
    expect(limiter.allow('c')).toBe(true);
    expect(limiter.allow('c')).toBe(false);

    // Remove and re-add — should reset
    limiter.remove('c');
    expect(limiter.allow('c')).toBe(true);
  });

  it('uses default values when no options provided', () => {
    const limiter = new RateLimiter();

    // Default is 30 messages per 60s — should allow 30
    for (let i = 0; i < 30; i++) {
      expect(limiter.allow('c')).toBe(true);
    }
    expect(limiter.allow('c')).toBe(false);
  });
});
