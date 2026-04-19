import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateZoteroAttachment } from '../../src/agent/tools/zotero-tools.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-test-'));
}

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
