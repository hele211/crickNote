import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CrickNoteWebSocket } from '../../obsidian-plugin/websocket-client';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.onclose?.();
  }
}

describe('CrickNoteWebSocket reconnect behavior', () => {
  const OriginalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (OriginalWebSocket) {
      globalThis.WebSocket = OriginalWebSocket;
    }
  });

  it('does not reconnect after an intentional disconnect', async () => {
    const client = new CrickNoteWebSocket({} as never);
    await client.connect();

    expect(FakeWebSocket.instances).toHaveLength(1);

    client.disconnect();
    vi.advanceTimersByTime(5000);

    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('still reconnects after an unintentional close', async () => {
    const client = new CrickNoteWebSocket({} as never);
    await client.connect();

    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].onclose?.();
    vi.advanceTimersByTime(5000);

    expect(FakeWebSocket.instances).toHaveLength(2);
    client.disconnect();
  });
});
