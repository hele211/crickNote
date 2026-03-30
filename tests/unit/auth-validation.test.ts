import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateAuthMessage, generateToken } from '../../src/server/auth.js';

// Redirect HOME to a temp dir so generateToken doesn't touch ~/.cricknote.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cricknote-auth-test-'));
const origHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = tmpHome;
  // Ensure the cricknote subdir exists so generateToken can write the token file.
  fs.mkdirSync(path.join(tmpHome, '.cricknote'), { recursive: true });
});

afterEach(() => {
  process.env.HOME = origHome;
  // Clean token file between tests.
  const tokenPath = path.join(tmpHome, '.cricknote', 'auth-token');
  if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
});

describe('validateAuthMessage — valid payload', () => {
  it('returns auth_ok for a valid token and correct protocol version', () => {
    const token = generateToken();
    const result = validateAuthMessage(
      { type: 'auth', token, protocolVersion: 1, pluginVersion: '0.1.0' },
      '0.1.0',
    );
    expect(result.type).toBe('auth_ok');
  });
});

describe('validateAuthMessage — field validation (no throws)', () => {
  it('returns version_mismatch for wrong protocol version number', () => {
    generateToken();
    const result = validateAuthMessage(
      { type: 'auth', token: 'x', protocolVersion: 99, pluginVersion: '0.1.0' },
      '0.1.0',
    );
    expect(result.type).toBe('auth_error');
    expect((result as { reason: string }).reason).toBe('version_mismatch');
  });

  it('returns version_mismatch instead of throwing when protocolVersion is missing', () => {
    generateToken();
    const malformed = { type: 'auth', token: 'x', pluginVersion: '0.1.0' } as never;
    expect(() => validateAuthMessage(malformed, '0.1.0')).not.toThrow();
    const result = validateAuthMessage(malformed, '0.1.0');
    expect((result as { reason: string }).reason).toBe('version_mismatch');
  });

  it('returns invalid_token instead of throwing when token field is missing', () => {
    generateToken();
    const malformed = { type: 'auth', protocolVersion: 1, pluginVersion: '0.1.0' } as never;
    expect(() => validateAuthMessage(malformed, '0.1.0')).not.toThrow();
    const result = validateAuthMessage(malformed, '0.1.0');
    expect(result.type).toBe('auth_error');
    expect((result as { reason: string }).reason).toBe('invalid_token');
  });

  it('returns invalid_token instead of throwing when token is a non-string', () => {
    generateToken();
    const malformed = { type: 'auth', token: 12345, protocolVersion: 1, pluginVersion: '0.1.0' } as never;
    expect(() => validateAuthMessage(malformed, '0.1.0')).not.toThrow();
    const result = validateAuthMessage(malformed, '0.1.0');
    expect(result.type).toBe('auth_error');
    expect((result as { reason: string }).reason).toBe('invalid_token');
  });

  it('returns invalid_token for an empty string token', () => {
    generateToken();
    const result = validateAuthMessage(
      { type: 'auth', token: '', protocolVersion: 1, pluginVersion: '0.1.0' },
      '0.1.0',
    );
    expect(result.type).toBe('auth_error');
    expect((result as { reason: string }).reason).toBe('invalid_token');
  });
});
