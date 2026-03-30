import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../storage/database.js';

const PROTOCOL_VERSION = 1;

export function getTokenPath(): string {
  return path.join(getDataDir(), 'auth-token');
}

export function generateToken(): string {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenPath = getTokenPath();
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
  fs.writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

export function readToken(): string {
  const tokenPath = getTokenPath();
  if (!fs.existsSync(tokenPath)) {
    throw new Error(`Auth token not found at ${tokenPath}. Run "cricknote setup" first.`);
  }
  return fs.readFileSync(tokenPath, 'utf-8').trim();
}

export function validateToken(provided: string): boolean {
  const stored = readToken();
  const a = Buffer.from(provided);
  const b = Buffer.from(stored);
  // timingSafeEqual requires equal-length buffers; length mismatch is itself
  // not secret, so we can short-circuit false without a timing leak concern.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function rotateToken(): string {
  return generateToken();
}

export function getProtocolVersion(): number {
  return PROTOCOL_VERSION;
}

export interface AuthMessage {
  type: 'auth';
  token: string;
  protocolVersion: number;
  pluginVersion: string;
}

export interface AuthOkMessage {
  type: 'auth_ok';
  protocolVersion: number;
  serviceVersion: string;
}

export interface AuthErrorMessage {
  type: 'auth_error';
  reason: 'invalid_token' | 'version_mismatch' | 'timeout';
  required?: number;
}

export function validateAuthMessage(
  msg: AuthMessage,
  serviceVersion: string
): AuthOkMessage | AuthErrorMessage {
  // Validate required fields are present and the right types before using them.
  // These checks guard against malformed payloads that were cast rather than validated.
  if (typeof msg.protocolVersion !== 'number') {
    return { type: 'auth_error', reason: 'version_mismatch', required: PROTOCOL_VERSION };
  }
  if (msg.protocolVersion !== PROTOCOL_VERSION) {
    return {
      type: 'auth_error',
      reason: 'version_mismatch',
      required: PROTOCOL_VERSION,
    };
  }

  if (typeof msg.token !== 'string' || msg.token.length === 0) {
    return { type: 'auth_error', reason: 'invalid_token' };
  }

  if (!validateToken(msg.token)) {
    return { type: 'auth_error', reason: 'invalid_token' };
  }

  return {
    type: 'auth_ok',
    protocolVersion: PROTOCOL_VERSION,
    serviceVersion,
  };
}
