import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateZoteroAttachment } from '../../src/agent/tools/zotero-tools.js';

// ─── HTTP mock for JSON-RPC ───────────────────────────────────────────────────

let mockResponses: Record<string, unknown> = {};

vi.mock('node:http', () => {
  return {
    default: {
      request: vi.fn((_options: unknown, callback: (res: unknown) => void) => {
        const chunks: string[] = [];
        const req = {
          on: vi.fn(),
          write: vi.fn((data: string) => { chunks.push(data); }),
          end: vi.fn(() => {
            const body = chunks.join('');
            let method = 'unknown';
            try { method = (JSON.parse(body) as { method: string }).method; } catch { /* ignore */ }
            const responseData = JSON.stringify(mockResponses[method] ?? { result: null });
            const res = {
              on: vi.fn((event: string, handler: (data?: string) => void) => {
                if (event === 'data') handler(responseData);
                if (event === 'end') handler();
              }),
            };
            callback(res);
          }),
        };
        return req;
      }),
    },
  };
});

// ─── Config mock ──────────────────────────────────────────────────────────────

vi.mock('../../src/config/config.js', async () => {
  const actual = await vi.importActual('../../src/config/config.js') as object;
  return {
    ...actual,
    loadConfig: () => ({
      vaultPath: '/tmp/test-vault',
      zotero: {
        enabled: true,
        api_port: 23119,
        storage_root: os.tmpdir(),
        auto_summarize: true,
      },
    }),
  };
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-test-'));
}

async function getZoteroFetchTool() {
  const { createZoteroTools } = await import('../../src/agent/tools/zotero-tools.js');
  return createZoteroTools('/tmp/test-vault').find(t => t.definition.name === 'zotero_fetch_item')!;
}

// ─── validateZoteroAttachment tests ──────────────────────────────────────────

describe('validateZoteroAttachment', () => {
  it('accepts a valid PDF inside storage root', () => {
    const root = makeTmpDir();
    const pdfPath = path.join(root, 'ABCD1234', 'paper.pdf');
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-valid content'));
    expect(() => validateZoteroAttachment(pdfPath, root)).not.toThrow();
  });

  it('rejects a path outside the storage root', () => {
    const root = makeTmpDir();
    const pdfPath = path.join(os.tmpdir(), 'outside.pdf');
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-outside'));
    expect(() => validateZoteroAttachment(pdfPath, root)).toThrow(/outside Zotero storage root/i);
  });

  it('rejects a symlink', () => {
    const root = makeTmpDir();
    const target = path.join(root, 'real.pdf');
    fs.writeFileSync(target, Buffer.from('%PDF-real'));
    const link = path.join(root, 'link.pdf');
    fs.symlinkSync(target, link);
    expect(() => validateZoteroAttachment(link, root)).toThrow(/symlink/i);
  });

  it('rejects a non-.pdf extension', () => {
    const root = makeTmpDir();
    const p = path.join(root, 'doc.txt');
    fs.writeFileSync(p, Buffer.from('%PDF-fake'));
    expect(() => validateZoteroAttachment(p, root)).toThrow(/\.pdf/i);
  });

  it('rejects wrong magic bytes', () => {
    const root = makeTmpDir();
    const p = path.join(root, 'bad.pdf');
    fs.writeFileSync(p, Buffer.from('NOTPDF content'));
    expect(() => validateZoteroAttachment(p, root)).toThrow(/magic bytes/i);
  });

  it('accepts a small valid PDF without throwing', () => {
    const root = makeTmpDir();
    const p = path.join(root, 'small.pdf');
    fs.writeFileSync(p, Buffer.from('%PDF-small'));
    expect(() => validateZoteroAttachment(p, root)).not.toThrow();
  });
});

// ─── zotero_fetch_item tests ──────────────────────────────────────────────────

describe('zotero_fetch_item — Path A (citekey)', () => {
  beforeEach(() => {
    mockResponses = {};
  });

  it('returns metadata + pdf_path for a valid citekey', async () => {
    const root = os.tmpdir();
    const pdfDir = path.join(root, 'AAAA1111');
    fs.mkdirSync(pdfDir, { recursive: true });
    const pdfPath = path.join(pdfDir, 'paper.pdf');
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-test'));

    mockResponses = {
      'api.ready': { result: true },
      'item.export': { result: JSON.stringify([{
        title: 'Test Paper',
        author: [{ family: 'Smith', given: 'John' }],
        issued: { 'date-parts': [[2026]] },
        'container-title': 'Cell',
        DOI: '10.1016/j.cell.2026',
      }]) },
      'item.attachments': { result: [{ id: 'att1', path: pdfPath, contentType: 'application/pdf', filename: 'paper.pdf', size: 100 }] },
    };

    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({ citekey: 'smith2026' }));
    expect(result.title).toBe('Test Paper');
    expect(result.authors[0]).toBe('Smith J');
    expect(result.year).toBe(2026);
    expect(result.journal).toBe('Cell');
    expect(result.citekey).toBe('smith2026');
    expect(result.pdf_path).toBe(pdfPath);
    expect(result.zotero_key).toBeUndefined();
    expect(result.slug_prefix).toBe('smith');
  });

  it('errors when no identifier provided', async () => {
    mockResponses = { 'api.ready': { result: true } };
    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({}));
    expect(result.error).toMatch(/required/i);
  });
});

describe('zotero_fetch_item — Path B (DOI)', () => {
  beforeEach(() => {
    mockResponses = {};
  });

  it('returns needs_item_selection when multiple items match DOI', async () => {
    mockResponses = {
      'api.ready': { result: true },
      'item.search': { result: [
        { itemKey: 'KEY1', libraryID: 1 },
        { itemKey: 'KEY2', libraryID: 1 },
      ]},
    };
    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({ doi: '10.1016/j.cell' }));
    expect(result.status).toBe('needs_item_selection');
    expect(result.candidates.length).toBe(2);
  });

  it('uses bare key for personal library (libraryID=1)', async () => {
    const root = os.tmpdir();
    const pdfPath = path.join(root, 'BBBB2222', 'paper.pdf');
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-test'));

    mockResponses = {
      'api.ready': { result: true },
      'item.search': { result: [{ itemKey: 'ABCD1234', libraryID: 1 }] },
      'item.citationkey': { result: { 'ABCD1234': 'smith2026' } },
      'item.export': { result: JSON.stringify([{
        title: 'Test', author: [{ family: 'Smith', given: 'J' }],
        issued: { 'date-parts': [[2026]] }, 'container-title': 'Cell',
      }]) },
      'item.attachments': { result: [{ id: 'a1', path: pdfPath, contentType: 'application/pdf', filename: 'paper.pdf', size: 100 }] },
    };
    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({ doi: 'https://doi.org/10.1016/j.cell' }));
    expect(result.zotero_key).toBe('ABCD1234');
  });

  it('uses prefixed key for group library (libraryID>1)', async () => {
    const root = os.tmpdir();
    const pdfPath = path.join(root, 'CCCC3333', 'paper.pdf');
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-test'));

    mockResponses = {
      'api.ready': { result: true },
      'item.search': { result: [{ itemKey: 'ABCD1234', libraryID: 12345 }] },
      'item.citationkey': { result: { '12345:ABCD1234': 'smith2026' } },
      'item.export': { result: JSON.stringify([{
        title: 'Test', author: [{ family: 'Smith', given: 'J' }],
        issued: { 'date-parts': [[2026]] }, 'container-title': 'Cell',
      }]) },
      'item.attachments': { result: [{ id: 'a1', path: pdfPath, contentType: 'application/pdf', filename: 'paper.pdf', size: 100 }] },
    };
    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({ doi: '10.1016/j.cell' }));
    expect(result.zotero_key).toBe('12345:ABCD1234');
  });
});

describe('zotero_fetch_item — Path C (zotero_key)', () => {
  beforeEach(() => {
    mockResponses = {};
  });

  it('resolves citekey from bare item key (personal library)', async () => {
    const root = os.tmpdir();
    const pdfPath = path.join(root, 'DDDD4444', 'paper.pdf');
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-test'));

    mockResponses = {
      'api.ready': { result: true },
      'item.citationkey': { result: { 'ZKEY1234': 'jones2025' } },
      'item.export': { result: JSON.stringify([{
        title: 'Jones Paper',
        author: [{ family: 'Jones', given: 'Alice' }],
        issued: { 'date-parts': [[2025]] },
        'container-title': 'Nature',
      }]) },
      'item.attachments': { result: [{ id: 'a1', path: pdfPath, contentType: 'application/pdf', filename: 'paper.pdf', size: 100 }] },
    };
    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({ zotero_key: 'ZKEY1234' }));
    expect(result.title).toBe('Jones Paper');
    expect(result.citekey).toBe('jones2025');
    expect(result.zotero_key).toBe('ZKEY1234');
  });

  it('resolves citekey from group-prefixed key', async () => {
    const root = os.tmpdir();
    const pdfPath = path.join(root, 'EEEE5555', 'paper.pdf');
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-test'));

    mockResponses = {
      'api.ready': { result: true },
      'item.citationkey': { result: { '99999:GRPKEY1': 'group2024' } },
      'item.export': { result: JSON.stringify([{
        title: 'Group Paper',
        author: [{ family: 'Group', given: 'Author' }],
        issued: { 'date-parts': [[2024]] },
        'container-title': 'Science',
      }]) },
      'item.attachments': { result: [{ id: 'a1', path: pdfPath, contentType: 'application/pdf', filename: 'paper.pdf', size: 100 }] },
    };
    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({ zotero_key: '99999:GRPKEY1' }));
    expect(result.title).toBe('Group Paper');
    expect(result.citekey).toBe('group2024');
    expect(result.zotero_key).toBe('99999:GRPKEY1');
  });

  it('errors when zotero_key has no matching citekey', async () => {
    mockResponses = {
      'api.ready': { result: true },
      'item.citationkey': { result: {} },
    };
    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({ zotero_key: 'MISSING1' }));
    expect(result.error).toMatch(/citekey/i);
  });
});

describe('zotero_fetch_item — CSL edge cases', () => {
  beforeEach(() => {
    mockResponses = {};
  });

  it('handles institutional author (literal only)', async () => {
    const root = os.tmpdir();
    const pdfPath = path.join(root, 'WHO2026', 'report.pdf');
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-test'));

    mockResponses = {
      'api.ready': { result: true },
      'item.export': { result: JSON.stringify([{
        title: 'WHO Report',
        author: [{ literal: 'World Health Organization' }],
        issued: { 'date-parts': [[2026]] },
        'container-title': 'WHO Publications',
      }]) },
      'item.attachments': { result: [{ id: 'a1', path: pdfPath, contentType: 'application/pdf', filename: 'report.pdf', size: 100 }] },
    };
    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({ citekey: 'who2026' }));
    expect(result.authors[0]).toBe('World Health Organization');
    expect(result.slug_prefix).toBe('world-health-organization');
  });

  it('errors when title is missing', async () => {
    mockResponses = {
      'api.ready': { result: true },
      'item.export': { result: JSON.stringify([{
        author: [{ family: 'Smith' }],
        issued: { 'date-parts': [[2026]] },
        'container-title': 'Cell',
      }]) },
      'item.attachments': { result: [] },
    };
    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({ citekey: 'smith2026' }));
    expect(result.error).toMatch(/no title/i);
  });
});

describe('zotero_fetch_item — no identifier', () => {
  beforeEach(() => {
    mockResponses = { 'api.ready': { result: true } };
  });

  it('errors when no identifier provided', async () => {
    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({}));
    expect(result.error).toMatch(/required/i);
  });
});
