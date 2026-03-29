import { EventEmitter } from 'events';
import type CrickNotePlugin from './main';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROTOCOL_VERSION = 1;

export class CrickNoteWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private plugin: CrickNotePlugin;
  private authenticated = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(plugin: CrickNotePlugin) {
    super();
    this.plugin = plugin;
  }

  async connect(): Promise<void> {
    const host = '127.0.0.1';
    const port = 18789;
    const url = `ws://${host}:${port}`;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        const token = this.readToken();
        if (!token) {
          console.error('CrickNote: No auth token found');
          return;
        }
        this.ws?.send(JSON.stringify({
          type: 'auth',
          token,
          protocolVersion: PROTOCOL_VERSION,
          pluginVersion: '0.1.0',
        }));
      };

      this.ws.onmessage = (event: MessageEvent) => {
        const msg = JSON.parse(event.data as string);
        this.handleMessage(msg);
      };

      this.ws.onclose = () => {
        this.authenticated = false;
        this.emit('disconnected');
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        // onclose will fire after this
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  send(message: Record<string, unknown>): void {
    if (!this.ws || !this.authenticated) return;
    this.ws.send(JSON.stringify(message));
  }

  sendChat(content: string): void {
    this.send({ type: 'chat', content });
  }

  confirmEdit(editId: string, action: 'apply' | 'force' | 'cancel'): void {
    this.send({ type: 'edit_confirm', editId, action });
  }

  requestStatus(): void {
    this.send({ type: 'status' });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'auth_ok':
        this.authenticated = true;
        this.emit('connected');
        this.requestStatus();
        break;

      case 'auth_error':
        console.error(`CrickNote auth error: ${msg.reason}`);
        this.emit('auth_error', msg);
        break;

      case 'chat_response':
        this.emit('chat_response', msg);
        break;

      case 'edit_result':
        this.emit('edit_result', msg);
        break;

      case 'status_response':
        if (msg.indexing) {
          this.emit('indexing', msg.indexing);
        }
        break;

      case 'error':
        this.emit('error', msg);
        break;
    }
  }

  private readToken(): string | null {
    const homeDir = process.env.HOME ?? '~';
    const tokenPath = join(homeDir, '.cricknote', 'auth-token');
    if (existsSync(tokenPath)) {
      return readFileSync(tokenPath, 'utf-8').trim();
    }
    return null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }
}
