import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { CrickNoteConfig } from '../config/config.js';
import { validateAuthMessage, type AuthMessage } from './auth.js';
import { AgentRuntime, type RuntimeResponse } from '../agent/runtime.js';
import { RateLimiter } from './rate-limiter.js';
import { logger } from '../utils/logger.js';

const log = logger.child('websocket');

export function mapPendingEditForPlugin(
  pe: RuntimeResponse['pendingEdits'][number],
  vaultPath: string,
): { editId: string; batchId: string | undefined; path: string; diff: string; hasConflict: boolean; warnings: string[] } {
  return {
    editId: pe.editId,
    batchId: pe.batchId,
    path: path.relative(vaultPath, pe.proposal.filePath),
    diff: pe.proposal.diff,
    hasConflict: pe.proposal.hasConflict,
    warnings: pe.warnings,
  };
}

interface AuthenticatedClient {
  ws: WebSocket;
  pluginVersion: string;
  sessionId: string;
  connectionId: string;
}

export function createWebSocketServer(config: CrickNoteConfig): Promise<WebSocketServer> {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host: config.server.host,
      port: config.server.port,
    });

    // Handle fatal startup errors (e.g. EADDRINUSE)
    wss.once('error', (error) => {
      log.error('WebSocket server error', { error: error.message });
      reject(error);
    });

    wss.once('listening', () => {
      // Replace the one-shot error handler with a persistent one for runtime errors
      wss.on('error', (error) => {
        log.error('WebSocket server error', { error: error.message });
      });
      resolve(wss);
    });

  const runtime = new AgentRuntime(config);
  const clients = new Map<WebSocket, AuthenticatedClient>();
  const rateLimiter = new RateLimiter({ maxMessages: 30, windowMs: 60_000 });
  let connectionCounter = 0;
  // Resolve the vault root through symlinks so path.relative() works correctly
  // when config.vaultPath is itself a symlink.
  let realVaultPath: string;
  try {
    realVaultPath = fs.realpathSync(config.vaultPath);
  } catch {
    realVaultPath = path.resolve(config.vaultPath);
  }

  wss.on('connection', (ws, req) => {
    // Reject non-loopback connections
    const remoteAddress = req.socket.remoteAddress;
    if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') {
      log.warn('Non-loopback connection rejected', { remoteAddress });
      ws.close(4003, 'Non-loopback connections rejected');
      return;
    }

    const connectionId = `conn-${++connectionCounter}`;

    // Auth timeout: 5 seconds
    const authTimeout = setTimeout(() => {
      if (!clients.has(ws)) {
        log.warn('Auth timeout — closing connection');
        ws.close(4001, 'Auth timeout');
      }
    }, 5000);

    ws.on('message', async (data) => {
      // Rate limiting — check before any processing
      if (!rateLimiter.allow(connectionId)) {
        log.warn('Rate limit exceeded', { connectionId });
        ws.send(JSON.stringify({ type: 'error', message: 'Rate limit exceeded. Try again shortly.' }));
        return;
      }

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }
      if (typeof msg !== 'object' || msg === null) {
        ws.send(JSON.stringify({ type: 'error', message: 'Message must be a JSON object' }));
        return;
      }

      // Handle auth
      if (msg.type === 'auth' && !clients.has(ws)) {
        clearTimeout(authTimeout);
        const result = validateAuthMessage(msg as unknown as AuthMessage, '0.1.0');

        if (result.type === 'auth_ok') {
          const sessionId = `obsidian-${Date.now()}`;
          clients.set(ws, {
            ws,
            pluginVersion: (msg as unknown as AuthMessage).pluginVersion,
            sessionId,
            connectionId,
          });
          log.info('Client authenticated', { sessionId, pluginVersion: (msg as unknown as AuthMessage).pluginVersion });
          ws.send(JSON.stringify(result));
        } else {
          log.warn('Auth rejected', { reason: result.reason });
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
        if (typeof msg.content !== 'string' || msg.content.length === 0) {
          ws.send(JSON.stringify({ type: 'error', message: 'content must be a non-empty string' }));
          return;
        }
        try {
          log.info('Chat message received', { sessionId: client.sessionId, length: (msg.content as string).length });
          const response = await runtime.processMessage(
            msg.content,
            client.sessionId,
            (text) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'chat_chunk', text }));
              }
            },
          );
          const pendingEdits = response.pendingEdits.map(pe => mapPendingEditForPlugin(pe, realVaultPath));
          log.info('Chat response sent', {
            sessionId: client.sessionId,
            toolCalls: response.toolCalls.length,
            pendingEdits: pendingEdits.length,
          });
          ws.send(JSON.stringify({
            type: 'chat_response',
            content: response.content,
            toolCalls: response.toolCalls,
            pendingEdits,
          }));
        } catch (err) {
          log.error('Chat processing failed', {
            sessionId: client.sessionId,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
          ws.send(JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'Unknown error',
          }));
        }
        return;
      }

      // Handle edit confirmations
      if (msg.type === 'edit_confirm') {
        const action = msg.action;
        if (action !== 'apply' && action !== 'force' && action !== 'cancel') {
          log.warn('Invalid edit_confirm action', { action });
          ws.send(JSON.stringify({ type: 'error', message: `Invalid action: "${action}". Must be apply, force, or cancel.` }));
          return;
        }
        const editId = typeof msg.editId === 'string' ? msg.editId : '';
        try {
          const result = await runtime.confirmEdit(editId, action, client.sessionId);
          log.info('Edit confirmed', { editId, action, success: result.success });
          ws.send(JSON.stringify({
            type: 'edit_result',
            editId,
            success: result.success,
            message: result.message,
          }));
        } catch (err) {
          log.error('Edit confirmation failed', { editId, action, error: err instanceof Error ? err.message : 'Unknown error' });
          ws.send(JSON.stringify({
            type: 'error',
            message: err instanceof Error ? err.message : 'Unknown error',
          }));
        }
        return;
      }

      // Handle status requests
      if (msg.type === 'status') {
        const status = runtime.getStatus();
        ws.send(JSON.stringify({ type: 'status_response', ...status }));
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      const client = clients.get(ws);
      if (client) {
        log.info('Client disconnected', { sessionId: client.sessionId });
        // Clean up any pending edits associated with this session
        runtime.cleanupSession(client.sessionId);
      }
      rateLimiter.remove(connectionId);
      clients.delete(ws);
    });
  });

  }); // end Promise
}
