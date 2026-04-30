import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateZoteroAttachment } from '../../src/agent/tools/zotero-tools.js';

// ─── HTTP mock for JSON-RPC ───────────────────────────────────────────────────

let mockResponses: Record<string, unknown> = {};
let mockRequests: Array<{ method: string; params: unknown[] }> = [];
const mockConfig = vi.hoisted(() => ({
  current: {
    vaultPath: '/tmp/test-vault',
    zotero: {
      enabled: true,
      api_port: 23119,
      storage_root: '/tmp',
      auto_summarize: true,
    },
  },
}));

vi.mock('node:http', () => {
  return {
    default: {
      request: vi.fn((_options: unknown, callback: (res: unknown) => void) => {
        const chunks: string[] = [];
        const req = {
          on: vi.fn(),
          setTimeout: vi.fn(),
          write: vi.fn((data: string) => { chunks.push(data); }),
          end: vi.fn(() => {
            const body = chunks.join('');
            let method = 'unknown';
            let params: unknown[] = [];
            try { method = (JSON.parse(body) as { method: string }).method; } catch { /* ignore */ }
            try { params = (JSON.parse(body) as { params?: unknown[] }).params ?? []; } catch { /* ignore */ }
            mockRequests.push({ method, params });
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
    loadConfig: () => mockConfig.current,
  };
});

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-test-'));
}

function resetMockConfig() {
  mockConfig.current = {
    vaultPath: '/tmp/test-vault',
    zotero: {
      enabled: true,
      api_port: 23119,
      storage_root: os.tmpdir(),
      vault_pdf_dir: 'Reading/attachments',
      auto_summarize: true,
    },
  };
}

async function getZoteroFetchTool() {
  const { createZoteroTools } = await import('../../src/agent/tools/zotero-tools.js');
  return createZoteroTools('/tmp/test-vault').find(t => t.definition.name === 'zotero_fetch_item')!;
}

async function getZoteroTools(vaultPath = '/tmp/test-vault') {
  const { createZoteroTools } = await import('../../src/agent/tools/zotero-tools.js');
  return createZoteroTools(vaultPath);
}

beforeEach(() => {
  resetMockConfig();
});

describe('Zotero tool config guard', () => {
  beforeEach(() => {
    mockResponses = {};
    mockRequests = [];
    resetMockConfig();
    mockConfig.current.zotero.enabled = false;
  });

  it('zotero_fetch_item refuses to run when zotero.enabled is false', async () => {
    const tools = await getZoteroTools();
    const tool = tools.find(t => t.definition.name === 'zotero_fetch_item')!;
    const result = JSON.parse(await tool.execute({ citekey: 'smith2026' }));
    expect(result.error).toMatch(/not enabled/i);
    expect(mockRequests).toEqual([]);
  });

  it('zotero_prepare_bundle refuses to run when zotero.enabled is false', async () => {
    const tools = await getZoteroTools();
    const tool = tools.find(t => t.definition.name === 'zotero_prepare_bundle')!;
    const result = JSON.parse(await tool.execute({ slug: 'smith-2026-il42', abstract: 'Abstract' }));
    expect(result.error).toMatch(/not enabled/i);
  });

  it('zotero_cleanup_bundle refuses to run when zotero.enabled is false', async () => {
    const tools = await getZoteroTools();
    const tool = tools.find(t => t.definition.name === 'zotero_cleanup_bundle')!;
    const result = JSON.parse(await tool.execute({ slug: 'smith-2026-il42' }));
    expect(result.error).toMatch(/not enabled/i);
  });
});

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
    mockRequests = [];
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

  it('accepts path-only PDF attachments returned by Better BibTeX', async () => {
    const root = os.tmpdir();
    const pdfDir = path.join(root, 'PATHONLY1');
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
      'item.attachments': { result: [{ open: 'zotero://open-pdf/library/items/AAAA1111', path: pdfPath }] },
    };

    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({ citekey: 'smith2026' }));
    expect(result.pdf_path).toBe(pdfPath);
  });

  it('accepts CSL year when date-parts uses strings', async () => {
    const root = os.tmpdir();
    const pdfDir = path.join(root, 'STRYEAR1');
    fs.mkdirSync(pdfDir, { recursive: true });
    const pdfPath = path.join(pdfDir, 'paper.pdf');
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-test'));

    mockResponses = {
      'api.ready': { result: true },
      'item.export': { result: JSON.stringify([{
        title: 'String Year Paper',
        author: [{ family: 'Yan', given: 'Yu' }],
        issued: { 'date-parts': [['2026']] },
        'container-title': 'Immunity',
      }]) },
      'item.attachments': { result: [{ id: 'att1', path: pdfPath, contentType: 'application/pdf', filename: 'paper.pdf', size: 100 }] },
    };

    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({ citekey: 'yanLocalAntibodyFeedback2026' }));
    expect(result.year).toBe(2026);
  });

  it('returns attachment choices for multiple PDFs and accepts the selected attachment id', async () => {
    const root = os.tmpdir();
    const firstPdf = path.join(root, 'MULTIPDF1', 'paper-a.pdf');
    const secondPdf = path.join(root, 'MULTIPDF2', 'paper-b.pdf');
    fs.mkdirSync(path.dirname(firstPdf), { recursive: true });
    fs.mkdirSync(path.dirname(secondPdf), { recursive: true });
    fs.writeFileSync(firstPdf, Buffer.from('%PDF-first'));
    fs.writeFileSync(secondPdf, Buffer.from('%PDF-second'));

    mockResponses = {
      'api.ready': { result: true },
      'item.export': { result: JSON.stringify([{
        title: 'Multi PDF Paper',
        author: [{ family: 'Smith', given: 'John' }],
        issued: { 'date-parts': [[2026]] },
        'container-title': 'Cell',
      }]) },
      'item.attachments': { result: [
        { id: 'att-a', path: firstPdf, contentType: 'application/pdf', filename: 'paper-a.pdf', size: 10 },
        { id: 'att-b', path: secondPdf, contentType: 'application/pdf', filename: 'paper-b.pdf', size: 20 },
      ] },
    };

    const tool = await getZoteroFetchTool();
    const choices = JSON.parse(await tool.execute({ citekey: 'smith2026' }));
    expect(choices.status).toBe('needs_attachment_selection');
    expect(choices.attachments).toEqual([
      { id: 'att-a', filename: 'paper-a.pdf', size: 10 },
      { id: 'att-b', filename: 'paper-b.pdf', size: 20 },
    ]);

    const selected = JSON.parse(await tool.execute({ citekey: 'smith2026', selected_attachment_id: 'att-b' }));
    expect(selected.pdf_path).toBe(secondPdf);
    expect(selected.title).toBe('Multi PDF Paper');
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
    mockRequests = [];
  });

  it('returns needs_item_selection with metadata when multiple items match DOI', async () => {
    mockResponses = {
      'api.ready': { result: true },
      'item.search': { result: [
        { itemKey: 'KEY1', libraryID: 1 },
        { itemKey: 'KEY2', libraryID: 1 },
      ]},
      'item.citationkey': { result: { 'KEY1': 'smith2026', 'KEY2': 'jones2025' } },
      'item.export': { result: JSON.stringify([{
        title: 'Test Title',
        author: [{ family: 'Smith', given: 'J' }],
        issued: { 'date-parts': [[2026]] },
        'container-title': 'Cell',
      }]) },
    };
    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({ doi: '10.1016/j.cell' }));
    expect(result.status).toBe('needs_item_selection');
    expect(result.candidates.length).toBe(2);
    expect(result.candidates[0].title).toBe('Test Title');
    expect(result.candidates[0].year).toBe(2026);
    expect(result.candidates[0].journal).toBe('Cell');
  });

  it('sends DOI advanced-search params with the nested JSON-RPC terms payload BBT expects', async () => {
    const root = os.tmpdir();
    const pdfPath = path.join(root, 'DOISEARCH1', 'paper.pdf');
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
    await tool.execute({ doi: '10.1016/j.cell' });

    const searchCall = mockRequests.find(req => req.method === 'item.search');
    expect(searchCall?.params).toEqual([[['DOI', 'is', '10.1016/j.cell']]]);
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

  it('accepts BBT search results that already include id and citekey', async () => {
    const root = os.tmpdir();
    const pdfPath = path.join(root, 'SEARCHSHAPE1', 'paper.pdf');
    fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-test'));

    mockResponses = {
      'api.ready': { result: true },
      'item.search': { result: [{
        id: 'http://zotero.org/users/4396856/items/C9VN7GH6',
        citekey: 'zhangGerminalCenterCells2013',
        title: 'Germinal center B cells govern their own fate via antibody feedback',
        issued: { 'date-parts': [['2013']] },
        'container-title': 'Journal of Experimental Medicine',
      }] },
      'item.export': { result: JSON.stringify([{
        title: 'Germinal center B cells govern their own fate via antibody feedback',
        author: [{ family: 'Zhang', given: 'Yang' }],
        issued: { 'date-parts': [['2013']] },
        'container-title': 'Journal of Experimental Medicine',
        DOI: '10.1084/jem.20120150',
      }]) },
      'item.attachments': { result: [{ id: 'a1', path: pdfPath, contentType: 'application/pdf', filename: 'paper.pdf', size: 100 }] },
    };

    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({ doi: '10.1084/jem.20120150' }));

    expect(result.citekey).toBe('zhangGerminalCenterCells2013');
    expect(result.zotero_key).toBe('C9VN7GH6');
    expect(result.year).toBe(2013);
    expect(mockRequests.some(req => req.method === 'item.citationkey')).toBe(false);
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
    mockRequests = [];
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
    mockRequests = [];
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
    mockRequests = [];
  });

  it('errors when no identifier provided', async () => {
    const tool = await getZoteroFetchTool();
    const result = JSON.parse(await tool.execute({}));
    expect(result.error).toMatch(/required/i);
  });
});

// ─── zotero_prepare_bundle tests ─────────────────────────────────────────────

async function getPrepareTool(vaultPath: string) {
  const { createZoteroTools } = await import('../../src/agent/tools/zotero-tools.js');
  return createZoteroTools(vaultPath).find((t: { definition: { name: string } }) => t.definition.name === 'zotero_prepare_bundle')!;
}

describe('zotero_prepare_bundle', () => {
  let vault: string;
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-vault-'));
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('rejects invalid slug format (../evil)', async () => {
    const tool = await getPrepareTool(vault);
    const result = JSON.parse(await tool.execute({ slug: '../evil' }));
    expect(result.error).toMatch(/invalid slug/i);
  });

  it('rejects invalid slug format (Smith_2026)', async () => {
    const tool = await getPrepareTool(vault);
    const result = JSON.parse(await tool.execute({ slug: 'Smith_2026' }));
    expect(result.error).toMatch(/invalid slug/i);
  });

  it('creates dir, links PDF, writes marker, returns source_type pdf', async () => {
    const pdfSrc = path.join(os.tmpdir(), `test-${Date.now()}.pdf`);
    fs.writeFileSync(pdfSrc, Buffer.from('%PDF-test-content'));
    const tool = await getPrepareTool(vault);
    const result = JSON.parse(await tool.execute({
      slug: 'smith-2026-il42',
      pdf_path: pdfSrc,
    }));
    expect(result.source_type).toBe('pdf');
    expect(result.source_path).toBe('paper.pdf');
    expect(result.pdf_copied).toBe(true);
    expect(result.files_created_this_run).toContain('paper.pdf');
    expect(fs.existsSync(path.join(vault, 'Reading/attachments/smith-2026-il42/paper.pdf'))).toBe(true);
    expect(fs.lstatSync(path.join(vault, 'Reading/attachments/smith-2026-il42/paper.pdf')).isFile()).toBe(true);
    expect(fs.existsSync(path.join(vault, 'Reading/attachments/smith-2026-il42/.zotero-bundle'))).toBe(true);
    fs.unlinkSync(pdfSrc);
  });

  it('idempotent: same PDF already present with matching SHA → files_created_this_run is empty', async () => {
    const pdfSrc = path.join(os.tmpdir(), `test-${Date.now()}.pdf`);
    fs.writeFileSync(pdfSrc, Buffer.from('%PDF-idempotent'));
    const tool = await getPrepareTool(vault);
    await tool.execute({ slug: 'smith-2026-il42', pdf_path: pdfSrc });
    const result = JSON.parse(await tool.execute({ slug: 'smith-2026-il42', pdf_path: pdfSrc }));
    expect(result.files_created_this_run).toEqual([]);
    fs.unlinkSync(pdfSrc);
  });

  it('errors if paper.pdf already exists with different content', async () => {
    const pdfSrc = path.join(os.tmpdir(), `test-${Date.now()}.pdf`);
    fs.writeFileSync(pdfSrc, Buffer.from('%PDF-original'));
    const tool = await getPrepareTool(vault);
    await tool.execute({ slug: 'smith-2026-il42', pdf_path: pdfSrc });
    const destPdf = path.join(vault, 'Reading/attachments/smith-2026-il42/paper.pdf');
    fs.unlinkSync(destPdf);
    fs.writeFileSync(destPdf, Buffer.from('%PDF-different-content'));
    const result = JSON.parse(await tool.execute({ slug: 'smith-2026-il42', pdf_path: pdfSrc }));
    expect(result.error).toMatch(/already exists/i);
    fs.unlinkSync(pdfSrc);
  });

  it('abstract-only mode writes abstract.md with correct format', async () => {
    const tool = await getPrepareTool(vault);
    const result = JSON.parse(await tool.execute({
      slug: 'who-2026-report',
      abstract: 'This is the abstract text.',
    }));
    expect(result.source_type).toBe('notes');
    expect(result.source_path).toBe('abstract.md');
    const written = fs.readFileSync(
      path.join(vault, 'Reading/attachments/who-2026-report/abstract.md'), 'utf-8'
    );
    expect(written).toBe('# Abstract\n\nThis is the abstract text.');
  });

  it('prefers PDF over abstract when both provided', async () => {
    const pdfSrc = path.join(os.tmpdir(), `test-${Date.now()}.pdf`);
    fs.writeFileSync(pdfSrc, Buffer.from('%PDF-both-mode'));
    const tool = await getPrepareTool(vault);
    const result = JSON.parse(await tool.execute({
      slug: 'smith-2026-both',
      pdf_path: pdfSrc,
      abstract: 'Some abstract',
    }));
    expect(result.source_type).toBe('pdf');
    fs.unlinkSync(pdfSrc);
  });

  it('rejects a symlinked bundle directory', async () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-outside-'));
    const attachmentsDir = path.join(vault, 'Reading', 'attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const link = path.join(attachmentsDir, 'evil-slug');
    fs.symlinkSync(target, link);
    const tool = await getPrepareTool(vault);
    const result = JSON.parse(await tool.execute({ slug: 'evil-slug', abstract: 'test' }));
    expect(result.error).toMatch(/symlink/i);
    fs.rmSync(target, { recursive: true, force: true });
  });

  it('refuses to overwrite a non-Zotero bundle directory (no marker)', async () => {
    const dir = path.join(vault, 'Reading/attachments/smith-2026-manual');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-manual');
    const tool = await getPrepareTool(vault);
    const result = JSON.parse(await tool.execute({
      slug: 'smith-2026-manual',
      abstract: 'Some abstract',
    }));
    expect(result.error).toMatch(/pre-existing manual bundle/i);
  });
});

// ─── zotero_cleanup_bundle tests ─────────────────────────────────────────────

function computeHash(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeTestMarker(dir: string, files: Record<string, string>): void {
  fs.writeFileSync(
    path.join(dir, '.zotero-bundle'),
    JSON.stringify({ created_by: 'zotero_prepare_bundle', files }, null, 2)
  );
}

async function getCleanupTool(vaultPath: string) {
  const { createZoteroTools } = await import('../../src/agent/tools/zotero-tools.js');
  return createZoteroTools(vaultPath).find((t: { definition: { name: string } }) => t.definition.name === 'zotero_cleanup_bundle')!;
}

describe('zotero_cleanup_bundle', () => {
  let vault: string;
  beforeEach(() => {
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-vault-'));
  });
  afterEach(() => {
    fs.rmSync(vault, { recursive: true, force: true });
  });

  it('refuses to operate when .zotero-bundle is absent', async () => {
    const dir = path.join(vault, 'Reading/attachments/test-slug');
    fs.mkdirSync(dir, { recursive: true });
    const result = JSON.parse(await (await getCleanupTool(vault)).execute({ slug: 'test-slug' }));
    expect(result.error).toMatch(/marker/i);
  });

  it('scoped cleanup: deletes only hash-matching files in the files list; out-of-scope files untouched', async () => {
    const dir = path.join(vault, 'Reading/attachments/test-slug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-content');
    fs.writeFileSync(path.join(dir, 'abstract.md'), '# Abstract\n\ntext');
    const pdfHash = computeHash(path.join(dir, 'paper.pdf'));
    const absHash = computeHash(path.join(dir, 'abstract.md'));
    writeTestMarker(dir, { 'paper.pdf': pdfHash, 'abstract.md': absHash });

    const result = JSON.parse(await (await getCleanupTool(vault)).execute({ slug: 'test-slug', files: ['paper.pdf'] }));
    expect(result.deleted).toContain('paper.pdf');
    expect(fs.existsSync(path.join(dir, 'paper.pdf'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'abstract.md'))).toBe(true);
    // Marker rewritten with only abstract.md
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.zotero-bundle'), 'utf-8'));
    expect(marker.files['abstract.md']).toBeDefined();
    expect(marker.files['paper.pdf']).toBeUndefined();
  });

  it('full cleanup (no files param): deletes all hash-matching marker entries, removes dir if empty', async () => {
    const dir = path.join(vault, 'Reading/attachments/test-slug2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-content');
    const pdfHash = computeHash(path.join(dir, 'paper.pdf'));
    writeTestMarker(dir, { 'paper.pdf': pdfHash });

    const result = JSON.parse(await (await getCleanupTool(vault)).execute({ slug: 'test-slug2' }));
    expect(result.deleted).toContain('paper.pdf');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('cleanup deletes only the managed PDF symlink and preserves the Zotero target', async () => {
    const dir = path.join(vault, 'Reading/attachments/test-symlink');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(os.tmpdir(), `zotero-target-${Date.now()}.pdf`);
    fs.writeFileSync(target, '%PDF-target');
    fs.symlinkSync(target, path.join(dir, 'paper.pdf'));
    const pdfHash = computeHash(path.join(dir, 'paper.pdf'));
    writeTestMarker(dir, { 'paper.pdf': pdfHash });

    const result = JSON.parse(await (await getCleanupTool(vault)).execute({ slug: 'test-symlink' }));
    expect(result.deleted).toContain('paper.pdf');
    expect(fs.existsSync(path.join(dir, 'paper.pdf'))).toBe(false);
    expect(fs.existsSync(target)).toBe(true);
    fs.unlinkSync(target);
  });

  it('hash mismatch: user-modified file is skipped and preserved in marker', async () => {
    const dir = path.join(vault, 'Reading/attachments/test-slug3');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-original');
    const originalHash = computeHash(path.join(dir, 'paper.pdf'));
    writeTestMarker(dir, { 'paper.pdf': originalHash });
    // User modifies file
    fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-modified-by-user');

    const result = JSON.parse(await (await getCleanupTool(vault)).execute({ slug: 'test-slug3' }));
    expect(result.skipped).toContain('paper.pdf');
    expect(fs.existsSync(path.join(dir, 'paper.pdf'))).toBe(true);
    // Marker still has the entry (hash-mismatch means ownership preserved)
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.zotero-bundle'), 'utf-8'));
    expect(marker.files['paper.pdf']).toBeDefined();
  });

  it('ghost entry (file already deleted): dropped from rewritten marker', async () => {
    const dir = path.join(vault, 'Reading/attachments/test-slug4');
    fs.mkdirSync(dir, { recursive: true });
    writeTestMarker(dir, { 'paper.pdf': 'some-hash' }); // file not present on disk
    const result = JSON.parse(await (await getCleanupTool(vault)).execute({ slug: 'test-slug4' }));
    // No entries remain → marker deleted, dir removed
    expect(fs.existsSync(path.join(dir, '.zotero-bundle'))).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
    expect(result.deleted ?? []).not.toContain('paper.pdf'); // already absent, not "deleted"
  });

  it('rejects invalid slug (path traversal attempt)', async () => {
    const result = JSON.parse(await (await getCleanupTool(vault)).execute({ slug: '../evil' }));
    expect(result.error).toMatch(/invalid slug/i);
  });

  it('rejects a symlinked bundle directory that resolves outside vault', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-outside-'));
    fs.writeFileSync(path.join(outside, '.zotero-bundle'), JSON.stringify({ created_by: 'zotero_prepare_bundle', files: {} }));
    const attachmentsDir = path.join(vault, 'Reading', 'attachments');
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const link = path.join(attachmentsDir, 'evil-slug');
    fs.symlinkSync(outside, link);
    const result = JSON.parse(await (await getCleanupTool(vault)).execute({ slug: 'evil-slug' }));
    expect(result.error).toMatch(/symlink/i);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('rejects a symlinked bundle directory even when target is inside vault', async () => {
    const attachmentsDir = path.join(vault, 'Reading', 'attachments');
    const realTarget = path.join(vault, 'Reading', 'attachments', 'real-slug');
    fs.mkdirSync(realTarget, { recursive: true });
    fs.writeFileSync(path.join(realTarget, '.zotero-bundle'), JSON.stringify({ created_by: 'zotero_prepare_bundle', files: {} }));
    const link = path.join(attachmentsDir, 'linked-slug');
    fs.symlinkSync(realTarget, link);
    const result = JSON.parse(await (await getCleanupTool(vault)).execute({ slug: 'linked-slug' }));
    expect(result.error).toMatch(/symlink/i);
  });

  it('rejects spoofed marker (wrong created_by)', async () => {
    const dir = path.join(vault, 'Reading/attachments/legit-slug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.zotero-bundle'),
      JSON.stringify({ created_by: 'attacker', files: { 'paper.pdf': 'abc' } }, null, 2)
    );
    const result = JSON.parse(await (await getCleanupTool(vault)).execute({ slug: 'legit-slug' }));
    expect(result.error).toMatch(/zotero_prepare_bundle/i);
  });

  it('skips marker entries with path-traversal filenames', async () => {
    const dir = path.join(vault, 'Reading/attachments/safe-slug');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'paper.pdf'), '%PDF-content');
    const pdfHash = computeHash(path.join(dir, 'paper.pdf'));
    // Marker has a traversal filename alongside a valid one
    fs.writeFileSync(
      path.join(dir, '.zotero-bundle'),
      JSON.stringify({ created_by: 'zotero_prepare_bundle', files: { '../outside.txt': 'x', 'paper.pdf': pdfHash } }, null, 2)
    );
    const result = JSON.parse(await (await getCleanupTool(vault)).execute({ slug: 'safe-slug' }));
    expect(result.skipped).toContain('../outside.txt');
    // paper.pdf should still be deleted normally
    expect(result.deleted).toContain('paper.pdf');
  });
});
