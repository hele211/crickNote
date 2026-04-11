/**
 * Simple sliding-window rate limiter for WebSocket connections.
 *
 * Tracks message timestamps per connection and rejects messages that
 * exceed the configured rate. Designed for local-only connections
 * (Obsidian plugin → CrickNote server) so the limits are generous.
 *
 * Usage:
 *   const limiter = new RateLimiter({ maxMessages: 20, windowMs: 60_000 });
 *   if (!limiter.allow(connectionId)) {
 *     // reject the message
 *   }
 *   limiter.remove(connectionId); // on disconnect
 */

export interface RateLimiterOptions {
  /** Maximum messages allowed within the window. Default: 30. */
  maxMessages?: number;
  /** Sliding window duration in milliseconds. Default: 60_000 (1 minute). */
  windowMs?: number;
}

export class RateLimiter {
  private readonly maxMessages: number;
  private readonly windowMs: number;
  private readonly windows = new Map<string, number[]>();

  constructor(options: RateLimiterOptions = {}) {
    this.maxMessages = options.maxMessages ?? 30;
    this.windowMs = options.windowMs ?? 60_000;
  }

  /**
   * Check whether a message from this connection is allowed.
   * Returns true if within rate limit, false if exceeded.
   */
  allow(connectionId: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(connectionId);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(connectionId, timestamps);
    }

    // Prune timestamps outside the window
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    if (timestamps.length >= this.maxMessages) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  /** Remove tracking for a disconnected client. */
  remove(connectionId: string): void {
    this.windows.delete(connectionId);
  }
}
