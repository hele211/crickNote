import { EventEmitter } from 'events';
import type CrickNotePlugin from './main';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROTOCOL_VERSION = 1;

export interface WebSocketOptions {
  host?: string;
  port?: number;
  tokenPath?: string;
}

export class CrickNoteWebSocket extends EventEmitter {
  private ws: WebSocket | null = null;
  private plugin: CrickNotePlugin;
  private authenticated = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectEnabled = true;
  private reconnectDelay = 1000;
  private host: string;
  private port: number;
  private tokenPath: string;

  constructor(plugin: CrickNotePlugin, options: WebSocketOptions = {}) {
    super();
    this.plugin = plugin;
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 18790;
    const homeDir = process.env.HOME ?? '~';
    this.tokenPath = options.tokenPath ?? join(homeDir, '.cricknote', 'auth-token');
  }

  async connect(): Promise<void> {
    this.reconnectEnabled = true;
    const host = this.host;
    const port = this.port;
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
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          console.error('CrickNote: received malformed WebSocket frame, ignoring');
          return;
        }
        this.handleMessage(msg);
      };

      this.ws.onclose = () => {
        this.authenticated = false;
        this.emit('disconnected');
        if (this.reconnectEnabled) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        // onclose will fire after this
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.reconnectEnabled = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    ws?.close();
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
        this.reconnectDelay = 1000; // reset backoff on successful connection
        this.emit('connected');
        this.requestStatus();
        break;

      case 'auth_error':
        console.error(`CrickNote auth error: ${msg.reason}`);
        this.emit('auth_error', msg);
        break;

      case 'chat_chunk':
        this.emit('chat_chunk', msg);
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
        this.emit('server_error', msg);
        break;
    }
  }

  private readToken(): string | null {
    if (existsSync(this.tokenPath)) {
      return readFileSync(this.tokenPath, 'utf-8').trim();
    }
    return null;
  }

  private scheduleReconnect(): void {
    if (!this.reconnectEnabled || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.reconnectEnabled) {
        this.connect();
      }
    }, delay);
  }
}
