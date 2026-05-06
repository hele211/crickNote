import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  let tmpDir: string;
  let tokenPath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-ws-client-'));
    tokenPath = path.join(tmpDir, 'auth-token');
    fs.writeFileSync(tokenPath, 'test-token');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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

  it('sends the persisted session id during authentication', async () => {
    const client = new CrickNoteWebSocket({} as never, {
      tokenPath,
      sessionId: 'obsidian-session-1',
    });
    await client.connect();

    FakeWebSocket.instances[0].onopen?.();

    expect(FakeWebSocket.instances[0].send).toHaveBeenCalledWith(JSON.stringify({
      type: 'auth',
      token: 'test-token',
      protocolVersion: 1,
      pluginVersion: '0.1.0',
      sessionId: 'obsidian-session-1',
    }));
  });
});
