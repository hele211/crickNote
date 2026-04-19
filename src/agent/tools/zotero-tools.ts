import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import type { ToolHandler } from './registry.js';
import { loadConfig, type CrickNoteConfig, type ZoteroConfig } from '../../config/config.js';
import { normalizeDoi, slugifyReadingTitle } from '../../knowledge/reading-note.js';

// ─── Config guard ────────────────────────────────────────────────────────────

function getZoteroConfig(config: CrickNoteConfig): ZoteroConfig | { error: string } {
  const z = config.zotero;
  if (!z?.enabled) {
    return { error: 'Zotero integration is not enabled. Set zotero.enabled: true in your CrickNote config.' };
  }
  return z;
}

// ─── PDF validation ──────────────────────────────────────────────────────────

export function validateZoteroAttachment(pdfPath: string, storageRoot: string): void {
  const realRoot = fs.realpathSync(storageRoot);

  const lstat = fs.lstatSync(pdfPath);
  if (lstat.isSymbolicLink()) throw new Error('symlink rejected — symlinks not allowed in Zotero storage');

  const realPdf = fs.realpathSync(pdfPath);

  if (realPdf !== realRoot && !realPdf.startsWith(realRoot + path.sep)) {
    throw new Error(`Path outside Zotero storage root: "${realPdf}"`);
  }

  const stat = fs.statSync(realPdf);
  if (!stat.isFile()) throw new Error('Not a regular file');
  if (!realPdf.toLowerCase().endsWith('.pdf')) throw new Error('Not a .pdf file — extension check failed');

  const fd = fs.openSync(realPdf, 'r');
  const magic = Buffer.alloc(4);
  try {
    fs.readSync(fd, magic, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (magic.toString('ascii') !== '%PDF') throw new Error('Not a PDF (magic bytes check failed)');

  const MB = 1024 * 1024;
  if (stat.size > 100 * MB) throw new Error(`PDF exceeds 100 MB limit (${(stat.size / MB).toFixed(1)} MB)`);
}

// ─── JSON-RPC helper ─────────────────────────────────────────────────────────

function jsonRpc(port: number, method: string, params: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 });
    const req = http.request(
      {
        host: '127.0.0.1', port, path: '/better-bibtex/json-rpc', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as { result?: unknown; error?: unknown };
            if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
            else resolve(parsed.result);
          } catch (e) { reject(e); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function apiReady(port: number): Promise<boolean> {
  try {
    await jsonRpc(port, 'api.ready', []);
    return true;
  } catch {
    return false;
  }
}

// ─── CSL normalization helpers ───────────────────────────────────────────────

function initials(given: string | undefined): string {
  if (!given || !given.trim()) return '';
  return given
    .split(/[\s-]+/)
    .map(part => part.charAt(0).toUpperCase())
    .join('');
}

interface CslAuthor { family?: string; given?: string; literal?: string }
interface CslItem {
  title?: string;
  author?: CslAuthor[];
  issued?: { 'date-parts'?: number[][] };
  'container-title'?: string;
  DOI?: string;
  abstract?: string;
}

export interface ZoteroFetchResult {
  title: string;
  authors: string[];
  year: number;
  journal: string;
  doi?: string;
  abstract?: string;
  pdf_path?: string;
  citekey: string;
  zotero_key?: string;
  slug_prefix: string;
}

function normalizeCsl(
  item: CslItem,
  citekey: string,
  pdfPath: string | undefined,
  zoteroKey: string | undefined
): ZoteroFetchResult | { error: string } {
  if (!item.title?.trim()) return { error: 'Item has no title.' };

  const rawAuthors = item.author ?? [];
  const authors: string[] = rawAuthors.map(a => {
    if (a.family) {
      const i = initials(a.given);
      return i ? `${a.family} ${i}` : a.family;
    }
    if (a.literal) return a.literal;
    return '';
  }).filter(Boolean);
  if (authors.length === 0) return { error: 'Item has no author.' };

  const yearRaw = item.issued?.['date-parts']?.[0]?.[0];
  if (typeof yearRaw !== 'number') return { error: 'Item has no publication year.' };

  if (!item['container-title']?.trim()) return { error: 'Item has no journal/container title.' };

  const firstAuthor = rawAuthors[0];
  const slugBase = firstAuthor?.family ?? firstAuthor?.literal ?? 'unknown';
  const slug_prefix = slugifyReadingTitle(slugBase);

  return {
    title: item.title.trim(),
    authors,
    year: yearRaw,
    journal: item['container-title'].trim(),
    doi: item.DOI ? normalizeDoi(item.DOI) : undefined,
    abstract: item.abstract || undefined,
    pdf_path: pdfPath,
    citekey,
    zotero_key: zoteroKey,
    slug_prefix,
  };
}

// ─── PDF selection ────────────────────────────────────────────────────────────

interface BbtAttachment {
  id?: string;
  path?: string;
  contentType?: string;
  filename?: string;
  parentItem?: string;
  size?: number;
}

type PdfSelectionResult =
  | string
  | { error: string }
  | { status: 'needs_attachment_selection'; attachments: { id: string; filename: string; size: number }[] };

function selectPdf(attachments: BbtAttachment[], selectedId?: string): PdfSelectionResult {
  const pdfs = attachments.filter(a => a.contentType === 'application/pdf' && a.path);
  if (pdfs.length === 0) {
    return { error: 'No PDF attached and no abstract available. Cannot ingest without at least one readable source. Open Zotero, add an abstract or attach a PDF, then retry.' };
  }

  if (selectedId) {
    const chosen = pdfs.find(a => a.id === selectedId);
    if (!chosen?.path) return { error: `Selected attachment ${selectedId} is not a valid PDF for this item.` };
    return chosen.path;
  }

  if (pdfs.length === 1) return pdfs[0].path!;

  return {
    status: 'needs_attachment_selection',
    attachments: pdfs.map(a => ({
      id: a.id ?? '',
      filename: a.filename ?? path.basename(a.path ?? ''),
      size: a.size ?? 0,
    })),
  };
}

// ─── SHA-256 helpers ──────────────────────────────────────────────────────────

function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}

// ─── Marker type ──────────────────────────────────────────────────────────────

interface ZoteroBundleMarker {
  created_by: 'zotero_prepare_bundle';
  files: Record<string, string>;
}

function readMarker(markerPath: string): ZoteroBundleMarker | null {
  try {
    return JSON.parse(fs.readFileSync(markerPath, 'utf-8')) as ZoteroBundleMarker;
  } catch {
    return null;
  }
}

function writeMarker(markerPath: string, files: Record<string, string>): void {
  const marker: ZoteroBundleMarker = { created_by: 'zotero_prepare_bundle', files };
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2));
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function createZoteroTools(vaultPath: string): ToolHandler[] {
  function cfg(): CrickNoteConfig { return loadConfig(); }

  // Placeholder — tools added in Tasks 11, 12, 13
  const tools: ToolHandler[] = [];
  return tools;
}
