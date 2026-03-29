import { WebSocketServer, WebSocket } from 'ws';
import type { CrickNoteConfig } from '../config/config.js';
import { validateAuthMessage, getProtocolVersion, type AuthMessage } from './auth.js';
import { AgentRuntime } from '../agent/runtime.js';

interface AuthenticatedClient {
  ws: WebSocket;
  pluginVersion: string;
  sessionId: string;
}

export function createWebSocketServer(config: CrickNoteConfig): WebSocketServer {
  const wss = new WebSocketServer({
    host: config.server.host,
    port: config.server.port,
  });

  const runtime = new AgentRuntime(config);
  const clients = new Map<WebSocket, AuthenticatedClient>();

  wss.on('connection', (ws, req) => {
    // Reject non-loopback connections
    const remoteAddress = req.socket.remoteAddress;
    if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') {
      ws.close(4003, 'Non-loopback connections rejected');
      return;
    }

    // Auth timeout: 5 seconds
    const authTimeout = setTimeout(() => {
      if (!clients.has(ws)) {
        ws.close(4001, 'Auth timeout');
      }
    }, 5000);

    ws.on('message', async (data) => {
      const msg = JSON.parse(data.toString());

      // Handle auth
      if (msg.type === 'auth' && !clients.has(ws)) {
        clearTimeout(authTimeout);
        const result = validateAuthMessage(msg as AuthMessage, '0.1.0');

        if (result.type === 'auth_ok') {
          const sessionId = `obsidian-${Date.now()}`;
          clients.set(ws, {
            ws,
            pluginVersion: (msg as AuthMessage).pluginVersion,
            sessionId,
          });
          ws.send(JSON.stringify(result));
        } else {
          ws.send(JSON.stringify(result));
          ws.close(4002, result.reason);
        }
        return;
      }

      // Reject unauthenticated messages
      const client = clients.get(ws);
      if (!client) {
        ws.close(4002, 'Not authenticated');
        return;
      }

      // Handle chat messages
      if (msg.type === 'chat') {
        try {
          const response = await runtime.processMessage(msg.content, client.sessionId);
          ws.send(JSON.stringify({
            type: 'chat_response',
            content: response.content,
            toolCalls: response.toolCalls,
            pendingEdits: response.pendingEdits,
          }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'Unknown error',
          }));
        }
      }

      // Handle edit confirmations
      if (msg.type === 'edit_confirm') {
        try {
          const result = await runtime.confirmEdit(msg.editId, msg.action);
          ws.send(JSON.stringify({
            type: 'edit_result',
            editId: msg.editId,
            success: result.success,
            message: result.message,
          }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'Unknown error',
          }));
        }
      }

      // Handle status requests
      if (msg.type === 'status') {
        const status = runtime.getStatus();
        ws.send(JSON.stringify({ type: 'status_response', ...status }));
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      clients.delete(ws);
    });
  });

  return wss;
}
