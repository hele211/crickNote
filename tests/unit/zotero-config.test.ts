import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('Zotero config normalization', () => {
  it('fills in Zotero defaults when zotero block is absent', async () => {
    const { normalizeZoteroConfig } = await import('../../src/config/config.js');
    const result = normalizeZoteroConfig(undefined);
    expect(result.enabled).toBe(false);
    expect(result.api_port).toBe(23119);
    expect(result.storage_root).toContain('Zotero/storage');
    expect(result.auto_summarize).toBe(true);
  });

  it('rejects api_port out of range (0)', async () => {
    const { normalizeZoteroConfig } = await import('../../src/config/config.js');
    expect(() => normalizeZoteroConfig({ enabled: true, api_port: 0, storage_root: '/tmp/zotero', auto_summarize: true }))
      .toThrow(/api_port/);
  });

  it('rejects api_port out of range (65536)', async () => {
    const { normalizeZoteroConfig } = await import('../../src/config/config.js');
    expect(() => normalizeZoteroConfig({ enabled: true, api_port: 65536, storage_root: '/tmp/zotero', auto_summarize: true }))
      .toThrow(/api_port/);
  });

  it('rejects storage_root resolving to /', async () => {
    const { normalizeZoteroConfig } = await import('../../src/config/config.js');
    expect(() => normalizeZoteroConfig({ enabled: true, api_port: 23119, storage_root: '/', auto_summarize: true }))
      .toThrow(/storage_root/);
  });

  it('expands ~ in storage_root', async () => {
    const { normalizeZoteroConfig } = await import('../../src/config/config.js');
    const result = normalizeZoteroConfig({ enabled: true, api_port: 23119, storage_root: '~/Zotero/storage', auto_summarize: true });
    expect(result.storage_root).toMatch(/^\/Users\/|^\/home\//);
    expect(result.storage_root).not.toContain('~');
  });

  it('rejects storage_root equal to home dir', async () => {
    const { normalizeZoteroConfig } = await import('../../src/config/config.js');
    const home = os.homedir();
    expect(() => normalizeZoteroConfig({ enabled: true, api_port: 23119, storage_root: home, auto_summarize: true }))
      .toThrow(/storage_root/);
  });
});
