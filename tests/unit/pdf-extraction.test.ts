import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectSources, loadSources } from '../../src/knowledge/source-loader.js';

function pdfEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

/**
 * Build a minimal valid multi-page PDF (one text line per page) with a correct,
 * CRLF-terminated xref table — exercises the real extraction path without a binary
 * fixture or a generator dependency. pdf.js rejects the "space + LF" xref entry
 * terminator as "bad XRef entry", so entries end in CRLF.
 */
function buildPdf(pageTexts: string[]): Buffer {
  const n = pageTexts.length;
  const fontNum = 3 + n * 2;
  const kids: string[] = [];
  for (let i = 0; i < n; i++) kids.push(`${3 + i * 2} 0 R`);

  const objects: Array<[number, string]> = [];
  objects.push([1, `<< /Type /Catalog /Pages 2 0 R >>`]);
  objects.push([2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`]);
  for (let i = 0; i < n; i++) {
    const pageNum = 3 + i * 2;
    const contentNum = 4 + i * 2;
    const stream = `BT /F1 12 Tf 72 700 Td (${pdfEscape(pageTexts[i])}) Tj ET`;
    objects.push([pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`]);
    objects.push([contentNum, `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`]);
  }
  objects.push([fontNum, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`]);
  objects.sort((a, b) => a[0] - b[0]);

  let pdf = `%PDF-1.4\n`;
  const offsets: Record<number, number> = {};
  for (const [num, body] of objects) {
    offsets[num] = Buffer.byteLength(pdf, 'latin1');
    pdf += `${num} 0 obj\n${body}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  const size = fontNum + 1;
  pdf += `xref\n0 ${size}\n0000000000 65535 f\r\n`;
  for (let num = 1; num <= fontNum; num++) {
    pdf += `${String(offsets[num] ?? 0).padStart(10, '0')} 00000 n\r\n`;
  }
  pdf += `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * pdf-parse's vendored pdf.js (v1.10.100) intermittently fails the first parse(s)
 * in a vitest worker — "bad XRef entry" or an empty page list — before it settles.
 * A real CLI run does a single parse per fresh process and is unaffected, so we
 * retry at the test level rather than contort production code.
 */
async function untilParsed<T>(run: () => Promise<T>, ok: (r: T) => boolean): Promise<T> {
  let result = await run();
  for (let i = 0; i < 8 && !ok(result); i++) result = await run();
  return result;
}

describe('PDF extraction path', () => {
  let vaultPath: string;
  const slug = 'trim21-2026';
  const dir = () => path.join(vaultPath, 'Reading', 'attachments', slug);

  beforeEach(() => {
    vaultPath = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-test-'));
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), 'paper.pdf'), buildPdf([
      'Fig. 1. TRIM21 recruits the proteasome.',
      'Figure 2 | Dose response. We also cite Fig. S1 here.',
      'Methods. Cells were lysed and blotted.',
    ]));
  });
  afterEach(() => { fs.rmSync(vaultPath, { recursive: true, force: true }); });

  it('inspects pages, captions, and supplementary gaps without returning text', async () => {
    const { sources } = await untilParsed(
      () => inspectSources([{ type: 'pdf', path: 'paper.pdf' }], slug, vaultPath),
      (r) => r.sources.length > 0 && r.sources[0].pageCount === 3,
    );
    expect(sources).toHaveLength(1);
    const s = sources[0];
    expect(s.pageCount).toBe(3);
    // Detects both classic "Fig. N." and Nature-style "Figure N |" captions.
    expect(s.figureCaptions?.map((c) => c.label)).toEqual(['Fig. 1', 'Fig. 2']);
    expect(s.supplementaryReferences).toContain('Fig. S1');
    // S1 is cited but no S1 caption is attached -> a supplement-coverage warning.
    expect(s.warnings.some((w) => /supplement/i.test(w))).toBe(true);
    expect(s).not.toHaveProperty('content');
  });

  it('loads the first page range with original page numbers and a nextPage cursor', async () => {
    const result = await untilParsed(
      () => loadSources([{ type: 'pdf', path: 'paper.pdf' }], slug, vaultPath, 'Reading/attachments', { pageStart: 1, pageEnd: 1 }),
      (r) => r.sources.length > 0,
    );
    const loaded = result.sources[0];
    expect(loaded.content).toContain('--- page 1 ---');
    expect(loaded.content).not.toContain('--- page 2 ---');
    expect(loaded.pageStart).toBe(1);
    expect(loaded.pageEnd).toBe(1);
    expect(loaded.pageCount).toBe(3);
    expect(loaded.nextPage).toBe(2);
  });

  it('preserves original page numbers for a mid-document range and ends the cursor', async () => {
    const result = await untilParsed(
      () => loadSources([{ type: 'pdf', path: 'paper.pdf' }], slug, vaultPath, 'Reading/attachments', { pageStart: 2, pageEnd: 3 }),
      (r) => r.sources.length > 0,
    );
    const loaded = result.sources[0];
    expect(loaded.content).toContain('--- page 2 ---');
    expect(loaded.content).toContain('--- page 3 ---');
    expect(loaded.content).not.toContain('--- page 1 ---');
    expect(loaded.nextPage).toBeUndefined();
  });
});
